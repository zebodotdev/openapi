import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const HTTP_METHODS = new Set([
  "delete",
  "get",
  "head",
  "options",
  "patch",
  "post",
  "put",
  "trace",
]);

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const specPath = join(rootDir, "commerce.yml");
const callDir = join(rootDir, "call");
const lockPath = join(callDir, "openapi.lock.json");
const updateLock = process.argv.includes("--update");

const spec = parse(readFileSync(specPath, "utf8"));
const operations = collectOpenApiOperations(spec);
const requests = collectCallRequests(callDir);
const errors = [
  ...compareOperationCoverage(operations, requests),
  ...compareEquivalentJsonContracts(operations, "POST /refunds/create", "POST /orders/refund"),
  ...validateRequestExamples(spec, operations, requests),
];

if (errors.length > 0) {
  console.error("OpenAPI and Call are out of sync:\n");
  for (const error of errors) {
    console.error(`- ${error}`);
  }
  process.exitCode = 1;
} else {
  const lock = buildLock(operations, requests);
  if (updateLock) {
    updateContractLock(lock);
  } else {
    checkLock(lock);
  }
}

function collectOpenApiOperations(document) {
  const result = new Map();

  for (const [pathName, pathItem] of Object.entries(document.paths ?? {})) {
    for (const [method, operation] of Object.entries(pathItem ?? {})) {
      if (!HTTP_METHODS.has(method.toLowerCase())) {
        continue;
      }

      const key = operationKey(method, pathName);
      if (result.has(key)) {
        throw new Error(`Duplicate OpenAPI operation ${key}`);
      }
      result.set(key, { key, method: method.toUpperCase(), path: pathName, operation });
    }
  }

  return result;
}

function collectCallRequests(directory) {
  const result = [];
  const collectionFiles = readdirSync(directory)
    .filter((name) => /^\d{2}-.+\.insomnia\.yaml$/.test(name) && !name.startsWith("00-"))
    .sort();

  for (const fileName of collectionFiles) {
    const filePath = join(directory, fileName);
    const document = parse(readFileSync(filePath, "utf8"));
    walkCollection(document.collection, (request) => {
      if (!request.method || !request.url) {
        return;
      }

      const mapping = openApiMapping(request);
      result.push({
        ...mapping,
        fileName,
        name: request.name ?? request.meta?.id ?? "Unnamed request",
        request,
      });
    });
  }

  return result;
}

function walkCollection(nodes, visit) {
  for (const node of nodes ?? []) {
    visit(node);
    walkCollection(node.children, visit);
  }
}

function openApiMapping(request) {
  const method = String(request.method).toUpperCase();
  const description = String(request.meta?.description ?? "");
  const explicit = description.match(/(?:^|\n)OpenAPI operation:\s*([A-Z]+)\s+(\/\S+)/i);

  if (explicit) {
    const mappedMethod = explicit[1].toUpperCase();
    if (mappedMethod !== method) {
      throw new Error(
        `${request.name}: request method ${method} conflicts with explicit OpenAPI mapping ${mappedMethod}`,
      );
    }
    return { key: operationKey(mappedMethod, explicit[2]), method: mappedMethod, path: explicit[2] };
  }

  const url = String(request.url);
  const directPath = url
    .replace(/^\{\{\s*base_url\s*\}\}/, "")
    .split("?", 1)[0];
  if (!directPath.startsWith("/")) {
    throw new Error(
      `${request.name}: dynamic URL ${url} must declare "OpenAPI operation: METHOD /path" in meta.description`,
    );
  }

  return { key: operationKey(method, directPath), method, path: directPath };
}

function compareOperationCoverage(operations, requests) {
  const errors = [];
  const requestsByOperation = new Map();
  const requestIds = new Map();

  for (const request of requests) {
    const matches = requestsByOperation.get(request.key) ?? [];
    matches.push(request);
    requestsByOperation.set(request.key, matches);

    const requestId = request.request.meta?.id;
    if (!requestId) {
      errors.push(`${request.fileName} > ${request.name}: request is missing meta.id`);
    } else if (requestIds.has(requestId)) {
      errors.push(
        `${request.fileName} > ${request.name}: duplicate request id ${requestId} also used by ${requestIds.get(requestId)}`,
      );
    } else {
      requestIds.set(requestId, `${request.fileName} > ${request.name}`);
    }
  }

  for (const key of operations.keys()) {
    const matches = requestsByOperation.get(key) ?? [];
    if (matches.length === 0) {
      errors.push(`${key} exists in commerce.yml but has no Call request`);
    } else if (matches.length > 1) {
      errors.push(
        `${key} is represented ${matches.length} times in Call: ${matches.map(requestLabel).join(", ")}`,
      );
    }
  }

  for (const [key, matches] of requestsByOperation) {
    if (!operations.has(key)) {
      errors.push(`${key} exists in Call but not in commerce.yml: ${matches.map(requestLabel).join(", ")}`);
    }
  }

  return errors;
}

function compareEquivalentJsonContracts(operations, canonicalKey, aliasKey) {
  const canonical = operations.get(canonicalKey)?.operation;
  const alias = operations.get(aliasKey)?.operation;
  if (!canonical || !alias) {
    return [];
  }

  const errors = [];

  if (JSON.stringify(canonical.parameters ?? []) !== JSON.stringify(alias.parameters ?? [])) {
    errors.push(`${aliasKey} must use the same parameters as ${canonicalKey}`);
  }
  if (JSON.stringify(canonical.requestBody) !== JSON.stringify(alias.requestBody)) {
    errors.push(`${aliasKey} must use the same request body as ${canonicalKey}`);
  }
  if (JSON.stringify(canonical.responses) !== JSON.stringify(alias.responses)) {
    errors.push(`${aliasKey} must use the same responses as ${canonicalKey}`);
  }

  return errors;
}

function validateRequestExamples(document, operations, requests) {
  const errors = [];

  for (const request of requests) {
    const openApiOperation = operations.get(request.key)?.operation;
    if (!openApiOperation) {
      continue;
    }

    const body = request.request.body;
    const requestBody = openApiOperation.requestBody;
    if (!body) {
      if (requestBody?.required) {
        errors.push(`${requestLabel(request)}: OpenAPI requires a request body but Call has none`);
      }
      continue;
    }

    if (!requestBody?.content) {
      errors.push(`${requestLabel(request)}: Call has a request body but OpenAPI documents none`);
      continue;
    }

    const mediaType = body.mimeType ?? "application/json";
    const schema = requestBody.content[mediaType]?.schema;
    if (!schema) {
      errors.push(
        `${requestLabel(request)}: Call uses ${mediaType}, which OpenAPI does not document for ${request.key}`,
      );
      continue;
    }

    let example;
    if (mediaType === "application/json") {
      try {
        example = JSON.parse(body.text ?? "");
      } catch (error) {
        errors.push(`${requestLabel(request)}: request body is not valid JSON (${error.message})`);
        continue;
      }
    } else if (mediaType === "multipart/form-data") {
      example = Object.fromEntries((body.params ?? []).map((part) => [part.name, part.value ?? part.fileName ?? ""]));
    } else {
      continue;
    }

    for (const error of validateExample(example, schema, document, "body")) {
      errors.push(`${requestLabel(request)}: ${error}`);
    }
  }

  return errors;
}

function validateExample(value, inputSchema, document, location) {
  const schema = materializeSchema(inputSchema, document);

  if (value === null && schema.nullable) {
    return [];
  }

  if (schema.oneOf?.length || schema.anyOf?.length) {
    const branches = schema.oneOf ?? schema.anyOf;
    const base = { ...schema };
    delete base.oneOf;
    delete base.anyOf;
    const branchErrors = branches.map((branch) =>
      validateExample(value, mergeSchemas(base, materializeSchema(branch, document)), document, location),
    );
    if (branchErrors.some((candidate) => candidate.length === 0)) {
      return [];
    }
    return [`${location} does not match any documented schema variant (${branchErrors[0].join("; ")})`];
  }

  const expectedType = schema.type ?? inferType(schema);
  if (expectedType === "object") {
    if (!isPlainObject(value)) {
      return [`${location} must be an object`];
    }

    const errors = [];
    for (const requiredName of schema.required ?? []) {
      if (!(requiredName in value)) {
        errors.push(`${location}.${requiredName} is required by OpenAPI`);
      }
    }

    const properties = schema.properties ?? {};
    for (const [name, childValue] of Object.entries(value)) {
      if (properties[name]) {
        errors.push(...validateExample(childValue, properties[name], document, `${location}.${name}`));
      } else if (isPlainObject(schema.additionalProperties)) {
        errors.push(...validateExample(childValue, schema.additionalProperties, document, `${location}.${name}`));
      } else if (schema.properties) {
        errors.push(`${location}.${name} is not documented by OpenAPI`);
      }
    }
    return errors;
  }

  if (expectedType === "array") {
    if (!Array.isArray(value)) {
      return [`${location} must be an array`];
    }
    return value.flatMap((item, index) =>
      schema.items ? validateExample(item, schema.items, document, `${location}[${index}]`) : [],
    );
  }

  if (expectedType === "integer" && !Number.isInteger(value)) {
    return [`${location} must be an integer`];
  }
  if (expectedType === "number" && typeof value !== "number") {
    return [`${location} must be a number`];
  }
  if (expectedType === "string" && typeof value !== "string") {
    return [`${location} must be a string`];
  }
  if (expectedType === "boolean" && typeof value !== "boolean") {
    return [`${location} must be a boolean`];
  }

  return [];
}

function materializeSchema(inputSchema, document, seen = new Set()) {
  if (!isPlainObject(inputSchema)) {
    return inputSchema ?? {};
  }

  let schema = { ...inputSchema };
  if (schema.$ref) {
    if (seen.has(schema.$ref)) {
      return {};
    }
    const nextSeen = new Set(seen).add(schema.$ref);
    schema = mergeSchemas(resolveRef(document, schema.$ref), { ...schema, $ref: undefined });
    schema = materializeSchema(schema, document, nextSeen);
  }

  if (schema.allOf) {
    const base = { ...schema };
    delete base.allOf;
    schema = schema.allOf.reduce(
      (merged, part) => mergeSchemas(merged, materializeSchema(part, document, seen)),
      base,
    );
  }

  return schema;
}

function mergeSchemas(left, right) {
  const merged = { ...left, ...right };
  if (left.properties || right.properties) {
    merged.properties = { ...(left.properties ?? {}), ...(right.properties ?? {}) };
  }
  if (left.required || right.required) {
    merged.required = [...new Set([...(left.required ?? []), ...(right.required ?? [])])];
  }
  return merged;
}

function resolveRef(document, reference) {
  if (!reference.startsWith("#/")) {
    throw new Error(`Unsupported external OpenAPI reference: ${reference}`);
  }
  return reference
    .slice(2)
    .split("/")
    .map((part) => part.replaceAll("~1", "/").replaceAll("~0", "~"))
    .reduce((value, part) => value?.[part], document) ?? {};
}

function inferType(schema) {
  if (schema.properties || schema.required || schema.additionalProperties) {
    return "object";
  }
  if (schema.items) {
    return "array";
  }
  return undefined;
}

function buildLock(operations, requests) {
  return {
    version: 1,
    openapi_sha256: hashFile(specPath),
    call_sha256: hashCallArtifacts(callDir),
    operation_count: operations.size,
    request_count: requests.length,
  };
}

function checkLock(actual) {
  if (!existsSync(lockPath)) {
    console.error("Missing call/openapi.lock.json. Run npm run contract:update after reviewing both contracts.");
    process.exitCode = 1;
    return;
  }

  const expected = JSON.parse(readFileSync(lockPath, "utf8"));
  const mismatches = Object.entries(actual)
    .filter(([name, value]) => expected[name] !== value)
    .map(([name, value]) => `${name}: expected ${expected[name] ?? "<missing>"}, received ${value}`);

  if (mismatches.length > 0) {
    console.error("OpenAPI or Call changed without refreshing their reviewed contract lock:\n");
    for (const mismatch of mismatches) {
      console.error(`- ${mismatch}`);
    }
    console.error("\nUpdate both contracts, review semantic parity, then run npm run contract:update.");
    process.exitCode = 1;
    return;
  }

  console.log(`OpenAPI and Call agree on ${actual.operation_count} operations and the reviewed contract lock is current.`);
}

function updateContractLock(actual) {
  if (existsSync(lockPath)) {
    const expected = JSON.parse(readFileSync(lockPath, "utf8"));
    const openApiChanged = expected.openapi_sha256 !== actual.openapi_sha256;
    const callChanged = expected.call_sha256 !== actual.call_sha256;

    if (openApiChanged !== callChanged) {
      console.error(
        "Refusing to refresh the contract lock after a one-sided change. Update commerce.yml and the matching Call collection together, then retry.",
      );
      process.exitCode = 1;
      return;
    }

    if (!openApiChanged && !callChanged) {
      console.log("OpenAPI and Call are unchanged; the reviewed contract lock is already current.");
      return;
    }
  }

  writeFileSync(lockPath, `${JSON.stringify(actual, null, 2)}\n`);
  console.log(`Updated ${relative(rootDir, lockPath)} for ${actual.operation_count} operations.`);
}

function hashFile(filePath) {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

function hashCallArtifacts(directory) {
  const files = walkFiles(directory)
    .filter((filePath) => filePath.endsWith(".insomnia.yaml"))
    .sort((left, right) => relative(directory, left).localeCompare(relative(directory, right)));
  const hash = createHash("sha256");
  for (const filePath of files) {
    hash.update(relative(directory, filePath));
    hash.update("\0");
    hash.update(readFileSync(filePath));
    hash.update("\0");
  }
  return hash.digest("hex");
}

function walkFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const filePath = join(directory, entry.name);
    return entry.isDirectory() ? walkFiles(filePath) : [filePath];
  });
}

function operationKey(method, pathName) {
  return `${String(method).toUpperCase()} ${pathName}`;
}

function requestLabel(request) {
  return `${request.fileName} > ${request.name}`;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
