import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import {
  buildPostmanArtifacts,
  listGeneratedPostmanFiles,
  stringifyPostmanArtifact,
} from "./postman.mjs";

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
const PUBLIC_CHECKOUT_OPERATIONS = new Set([
  "POST /checkout/lookup",
  "POST /checkout/pay",
  "POST /checkout/request_confirmation",
  "POST /checkout/confirm_payment",
]);

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const specPath = join(rootDir, "commerce.yml");
const insomniaDir = join(rootDir, "insomnia");
const postmanDir = join(rootDir, "postman");
const lockPath = join(rootDir, "contract.lock.json");
const updateLock = process.argv.includes("--update");

const spec = parse(readFileSync(specPath, "utf8"));
const operations = collectOpenApiOperations(spec);
const insomniaRequests = collectInsomniaRequests(insomniaDir);
const postmanRequests = collectPostmanRequests(postmanDir);
const errors = [
  ...validateGeneratedPostmanArtifacts(insomniaDir, postmanDir),
  ...validateCollectionVersions(spec, insomniaDir, postmanDir),
  ...compareOperationCoverage(operations, insomniaRequests, "Insomnia", true),
  ...compareOperationCoverage(operations, postmanRequests, "Postman", false),
  ...validatePublicCheckoutOperations(operations),
  ...compareEquivalentJsonContracts(
    operations,
    "POST /refunds/create",
    "POST /orders/refund",
  ),
  ...validateRequestExamples(spec, operations, insomniaRequests),
  ...validateRequestExamples(spec, operations, postmanRequests),
];

if (errors.length > 0) {
  console.error("OpenAPI, Insomnia, and Postman are out of sync:\n");
  for (const error of errors) {
    console.error(`- ${error}`);
  }
  process.exitCode = 1;
} else {
  const lock = buildLock(operations, insomniaRequests, postmanRequests);
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
      result.set(key, {
        key,
        method: method.toUpperCase(),
        path: pathName,
        operation,
      });
    }
  }

  return result;
}

function collectInsomniaRequests(directory) {
  const result = [];
  const collectionFiles = readdirSync(directory)
    .filter(
      (name) =>
        /^\d{2}-.+\.insomnia\.yaml$/.test(name) && !name.startsWith("00-"),
    )
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
        client: "Insomnia",
        fileName,
        name: request.name ?? request.meta?.id ?? "Unnamed request",
        request,
      });
    });
  }

  return result;
}

function collectPostmanRequests(directory) {
  const result = [];
  const collectionFiles = readdirSync(directory)
    .filter((name) => /^\d{2}-.+\.postman_collection\.json$/.test(name))
    .sort();

  for (const fileName of collectionFiles) {
    const filePath = join(directory, fileName);
    const document = JSON.parse(readFileSync(filePath, "utf8"));
    walkPostmanCollection(document.item, (item) => {
      const postmanRequest = item.request;
      if (!postmanRequest?.method || !postmanRequest.url) {
        return;
      }

      const request = normalizePostmanRequest(postmanRequest);
      const mapping = openApiMapping(request);
      result.push({
        ...mapping,
        client: "Postman",
        fileName,
        name: item.name ?? "Unnamed request",
        request,
      });
    });
  }

  return result;
}

function walkPostmanCollection(items, visit) {
  for (const item of items ?? []) {
    if (item.request) {
      visit(item);
    }
    walkPostmanCollection(item.item, visit);
  }
}

function normalizePostmanRequest(request) {
  const url = typeof request.url === "string" ? request.url : request.url?.raw;
  const description =
    typeof request.description === "string"
      ? request.description
      : (request.description?.content ?? "");
  const normalized = {
    method: request.method,
    url,
    meta: { description },
    headers: (request.header ?? []).map((header) => ({
      name: header.key,
      value: header.value,
      disabled: header.disabled,
    })),
  };

  if (request.body?.mode === "raw") {
    normalized.body = {
      mimeType:
        request.body.options?.raw?.language === "json"
          ? "application/json"
          : "text/plain",
      text: request.body.raw ?? "",
    };
  } else if (request.body?.mode === "formdata") {
    normalized.body = {
      mimeType: "multipart/form-data",
      params: (request.body.formdata ?? []).map((part) => ({
        name: part.key,
        value: part.value,
        fileName: part.src,
        type: part.type,
      })),
    };
  }

  return normalized;
}

function validateGeneratedPostmanArtifacts(sourceDirectory, outputDirectory) {
  const errors = [];
  const expectedArtifacts = buildPostmanArtifacts(sourceDirectory);

  for (const [relativePath, artifact] of expectedArtifacts) {
    const outputPath = join(outputDirectory, relativePath);
    if (!existsSync(outputPath)) {
      errors.push(
        `Postman is missing generated artifact postman/${relativePath}`,
      );
      continue;
    }
    const expected = stringifyPostmanArtifact(artifact);
    if (readFileSync(outputPath, "utf8") !== expected) {
      errors.push(
        `postman/${relativePath} does not match its Insomnia source; run npm run postman:generate`,
      );
    }
  }

  if (existsSync(outputDirectory)) {
    for (const relativePath of listGeneratedPostmanFiles(outputDirectory)) {
      if (!expectedArtifacts.has(relativePath)) {
        errors.push(
          `Postman contains unexpected generated artifact postman/${relativePath}`,
        );
      }
    }
  }

  return errors;
}

function validateCollectionVersions(
  document,
  sourceDirectory,
  outputDirectory,
) {
  const errors = [];
  const apiVersion = document.info?.version;
  const collectionVersion = document.info?.["x-inttegro-collection-version"];
  const environment = parse(
    readFileSync(join(sourceDirectory, "00-environment.insomnia.yaml"), "utf8"),
  );
  const insomniaVersion = environment.environments?.data?.collection_version;

  if (typeof collectionVersion !== "string" || collectionVersion.length === 0) {
    errors.push("commerce.yml must declare info.x-inttegro-collection-version");
  }
  if (collectionVersion !== apiVersion) {
    errors.push(
      `Collection version ${collectionVersion ?? "<missing>"} does not match OpenAPI info.version ${apiVersion ?? "<missing>"}`,
    );
  }
  if (insomniaVersion !== collectionVersion) {
    errors.push(
      `Insomnia collection_version ${insomniaVersion ?? "<missing>"} does not match collection version ${collectionVersion ?? "<missing>"}`,
    );
  }

  for (const fileName of walkFiles(outputDirectory)
    .map((filePath) => relative(outputDirectory, filePath))
    .filter((name) => name.endsWith(".postman_collection.json"))
    .sort()) {
    const postman = JSON.parse(
      readFileSync(join(outputDirectory, fileName), "utf8"),
    );
    if (postman.info?.version !== collectionVersion) {
      errors.push(
        `Postman ${fileName} version ${postman.info?.version ?? "<missing>"} does not match collection version ${collectionVersion ?? "<missing>"}`,
      );
    }
  }

  return errors;
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
  const explicit = description.match(
    /(?:^|\n)OpenAPI operation:\s*([A-Z]+)\s+(\/\S+)/i,
  );

  if (explicit) {
    const mappedMethod = explicit[1].toUpperCase();
    if (mappedMethod !== method) {
      throw new Error(
        `${request.name}: request method ${method} conflicts with explicit OpenAPI mapping ${mappedMethod}`,
      );
    }
    return {
      key: operationKey(mappedMethod, explicit[2]),
      method: mappedMethod,
      path: explicit[2],
    };
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

function compareOperationCoverage(
  operations,
  requests,
  clientName,
  requireIds,
) {
  const errors = [];
  const requestsByOperation = new Map();
  const requestIds = new Map();

  for (const request of requests) {
    const matches = requestsByOperation.get(request.key) ?? [];
    matches.push(request);
    requestsByOperation.set(request.key, matches);

    if (requireIds) {
      const requestId = request.request.meta?.id;
      if (!requestId) {
        errors.push(`${requestLabel(request)}: request is missing meta.id`);
      } else if (requestIds.has(requestId)) {
        errors.push(
          `${requestLabel(request)}: duplicate request id ${requestId} also used by ${requestIds.get(requestId)}`,
        );
      } else {
        requestIds.set(requestId, requestLabel(request));
      }
    }
  }

  for (const key of operations.keys()) {
    const matches = requestsByOperation.get(key) ?? [];
    if (matches.length === 0) {
      errors.push(
        `${key} exists in commerce.yml but has no ${clientName} request`,
      );
    } else if (matches.length > 1) {
      errors.push(
        `${key} is represented ${matches.length} times in ${clientName}: ${matches.map(requestLabel).join(", ")}`,
      );
    }
  }

  for (const [key, matches] of requestsByOperation) {
    if (!operations.has(key)) {
      errors.push(
        `${key} exists in ${clientName} but not in commerce.yml: ${matches.map(requestLabel).join(", ")}`,
      );
    }
  }

  return errors;
}

function validatePublicCheckoutOperations(operations) {
  const errors = [];

  for (const key of PUBLIC_CHECKOUT_OPERATIONS) {
    const operation = operations.get(key)?.operation;
    if (!operation) {
      errors.push(`${key} must remain in the public OpenAPI contract`);
    } else if (
      !Array.isArray(operation.security) ||
      operation.security.length !== 0
    ) {
      errors.push(
        `${key} must declare security: [] because checkout is a public capability`,
      );
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

  if (
    JSON.stringify(canonical.parameters ?? []) !==
    JSON.stringify(alias.parameters ?? [])
  ) {
    errors.push(`${aliasKey} must use the same parameters as ${canonicalKey}`);
  }
  if (
    JSON.stringify(canonical.requestBody) !== JSON.stringify(alias.requestBody)
  ) {
    errors.push(
      `${aliasKey} must use the same request body as ${canonicalKey}`,
    );
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
        errors.push(
          `${requestLabel(request)}: OpenAPI requires a request body but the collection has none`,
        );
      }
      continue;
    }

    if (!requestBody?.content) {
      errors.push(
        `${requestLabel(request)}: the collection has a request body but OpenAPI documents none`,
      );
      continue;
    }

    const mediaType = body.mimeType ?? "application/json";
    const schema = requestBody.content[mediaType]?.schema;
    if (!schema) {
      errors.push(
        `${requestLabel(request)}: the collection uses ${mediaType}, which OpenAPI does not document for ${request.key}`,
      );
      continue;
    }

    let example;
    if (mediaType === "application/json") {
      try {
        example = JSON.parse(body.text ?? "");
      } catch (error) {
        errors.push(
          `${requestLabel(request)}: request body is not valid JSON (${error.message})`,
        );
        continue;
      }
    } else if (mediaType === "multipart/form-data") {
      example = Object.fromEntries(
        (body.params ?? []).map((part) => [
          part.name,
          part.value ?? part.fileName ?? "",
        ]),
      );
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
      validateExample(
        value,
        mergeSchemas(base, materializeSchema(branch, document)),
        document,
        location,
      ),
    );
    if (branchErrors.some((candidate) => candidate.length === 0)) {
      return [];
    }
    return [
      `${location} does not match any documented schema variant (${branchErrors[0].join("; ")})`,
    ];
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
        errors.push(
          ...validateExample(
            childValue,
            properties[name],
            document,
            `${location}.${name}`,
          ),
        );
      } else if (isPlainObject(schema.additionalProperties)) {
        errors.push(
          ...validateExample(
            childValue,
            schema.additionalProperties,
            document,
            `${location}.${name}`,
          ),
        );
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
      schema.items
        ? validateExample(item, schema.items, document, `${location}[${index}]`)
        : [],
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
    schema = mergeSchemas(resolveRef(document, schema.$ref), {
      ...schema,
      $ref: undefined,
    });
    schema = materializeSchema(schema, document, nextSeen);
  }

  if (schema.allOf) {
    const base = { ...schema };
    delete base.allOf;
    schema = schema.allOf.reduce(
      (merged, part) =>
        mergeSchemas(merged, materializeSchema(part, document, seen)),
      base,
    );
  }

  return schema;
}

function mergeSchemas(left, right) {
  const merged = { ...left, ...right };
  if (left.properties || right.properties) {
    merged.properties = {
      ...(left.properties ?? {}),
      ...(right.properties ?? {}),
    };
  }
  if (left.required || right.required) {
    merged.required = [
      ...new Set([...(left.required ?? []), ...(right.required ?? [])]),
    ];
  }
  return merged;
}

function resolveRef(document, reference) {
  if (!reference.startsWith("#/")) {
    throw new Error(`Unsupported external OpenAPI reference: ${reference}`);
  }
  return (
    reference
      .slice(2)
      .split("/")
      .map((part) => part.replaceAll("~1", "/").replaceAll("~0", "~"))
      .reduce((value, part) => value?.[part], document) ?? {}
  );
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

function buildLock(operations, insomniaRequests, postmanRequests) {
  return {
    version: 3,
    collection_version: spec.info?.["x-inttegro-collection-version"] ?? "",
    openapi_sha256: hashFile(specPath),
    insomnia_sha256: hashArtifacts(insomniaDir, (filePath) =>
      filePath.endsWith(".insomnia.yaml"),
    ),
    postman_sha256: hashArtifacts(postmanDir, (filePath) =>
      /\.postman_(?:collection|environment)\.json$/.test(filePath),
    ),
    operation_count: operations.size,
    insomnia_request_count: insomniaRequests.length,
    postman_request_count: postmanRequests.length,
  };
}

function checkLock(actual) {
  if (!existsSync(lockPath)) {
    console.error(
      "Missing contract.lock.json. Run npm run contract:update after reviewing all contracts.",
    );
    process.exitCode = 1;
    return;
  }

  const expected = JSON.parse(readFileSync(lockPath, "utf8"));
  const mismatches = Object.entries(actual)
    .filter(([name, value]) => expected[name] !== value)
    .map(
      ([name, value]) =>
        `${name}: expected ${expected[name] ?? "<missing>"}, received ${value}`,
    );

  if (mismatches.length > 0) {
    console.error(
      "OpenAPI or a client collection changed without refreshing the reviewed contract lock:\n",
    );
    for (const mismatch of mismatches) {
      console.error(`- ${mismatch}`);
    }
    console.error(
      "\nUpdate OpenAPI and Insomnia, regenerate Postman, review parity, then run npm run contract:update.",
    );
    process.exitCode = 1;
    return;
  }

  console.log(
    `OpenAPI, Insomnia, and Postman agree on ${actual.operation_count} operations and the reviewed contract lock is current.`,
  );
}

function updateContractLock(actual) {
  if (existsSync(lockPath)) {
    const expected = JSON.parse(readFileSync(lockPath, "utf8"));
    const openApiChanged = expected.openapi_sha256 !== actual.openapi_sha256;
    const previousInsomniaHash =
      expected.insomnia_sha256 ?? expected.call_sha256;
    const insomniaChanged = previousInsomniaHash !== actual.insomnia_sha256;
    const postmanChanged = expected.postman_sha256 !== actual.postman_sha256;

    if (openApiChanged !== insomniaChanged) {
      console.error(
        "Refusing to refresh the contract lock after a one-sided change. Update commerce.yml and the matching Insomnia collection together, regenerate Postman, then retry.",
      );
      process.exitCode = 1;
      return;
    }

    if (
      expected.collection_version &&
      expected.collection_version === actual.collection_version &&
      (openApiChanged || insomniaChanged || postmanChanged)
    ) {
      console.error(
        `Refusing to refresh changed collection artifacts without bumping collection version ${actual.collection_version}.`,
      );
      process.exitCode = 1;
      return;
    }

    const lockChanged = Object.entries(actual).some(
      ([name, value]) => expected[name] !== value,
    );
    if (!lockChanged) {
      console.log(
        "OpenAPI and client collections are unchanged; the reviewed contract lock is already current.",
      );
      return;
    }
  }

  writeFileSync(lockPath, `${JSON.stringify(actual, null, 2)}\n`);
  console.log(
    `Updated ${relative(rootDir, lockPath)} for ${actual.operation_count} operations.`,
  );
}

function hashFile(filePath) {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

function hashArtifacts(directory, include) {
  const files = walkFiles(directory)
    .filter(include)
    .sort((left, right) =>
      relative(directory, left).localeCompare(relative(directory, right)),
    );
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
  return `${request.client} ${request.fileName} > ${request.name}`;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
