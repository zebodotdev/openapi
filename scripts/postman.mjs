import { readFileSync, readdirSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { parse } from "yaml";

export const POSTMAN_COLLECTION_SCHEMA =
  "https://schema.getpostman.com/json/collection/v2.1.0/collection.json";

const PRIMARY_INSOMNIA_FILE = /^\d{2}-.+\.insomnia\.yaml$/;
const GENERATED_POSTMAN_FILE = /\.postman_(?:collection|environment)\.json$/;

export function buildPostmanArtifacts(insomniaDir) {
  const artifacts = new Map();
  const environmentPath = join(insomniaDir, "00-environment.insomnia.yaml");
  const environment = readInsomniaDocument(environmentPath);
  const collectionVersion = environment.environments?.data?.collection_version;

  artifacts.set(
    "00-environment.postman_environment.json",
    convertEnvironment(environment),
  );

  for (const fileName of readdirSync(insomniaDir)
    .filter(
      (name) => PRIMARY_INSOMNIA_FILE.test(name) && !name.startsWith("00-"),
    )
    .sort()) {
    const sourcePath = join(insomniaDir, fileName);
    const outputName = fileName.replace(
      /\.insomnia\.yaml$/,
      ".postman_collection.json",
    );
    artifacts.set(
      outputName,
      convertCollection(
        readInsomniaDocument(sourcePath),
        `insomnia/${fileName}`,
        collectionVersion,
      ),
    );
  }

  const workflowsDir = join(insomniaDir, "workflows");
  for (const fileName of readdirSync(workflowsDir)
    .filter((name) => name.endsWith(".insomnia.yaml"))
    .sort()) {
    const sourcePath = join(workflowsDir, fileName);
    const outputName = fileName.replace(
      /\.insomnia\.yaml$/,
      ".postman_collection.json",
    );
    artifacts.set(
      join("workflows", outputName),
      convertCollection(
        readInsomniaDocument(sourcePath),
        `insomnia/workflows/${fileName}`,
        collectionVersion,
      ),
    );
  }

  return artifacts;
}

export function listGeneratedPostmanFiles(postmanDir) {
  return walkFiles(postmanDir)
    .filter((filePath) => GENERATED_POSTMAN_FILE.test(filePath))
    .map((filePath) => relative(postmanDir, filePath))
    .sort();
}

export function stringifyPostmanArtifact(artifact) {
  return `${JSON.stringify(artifact, null, 2)}\n`;
}

function readInsomniaDocument(filePath) {
  return parse(readFileSync(filePath, "utf8"));
}

function convertEnvironment(document) {
  const data = document.environments?.data ?? {};

  return {
    name: document.name ?? document.environments?.name ?? "Inttegro API",
    values: Object.entries(data).map(([key, value]) => ({
      key,
      value: value ?? "",
      type: key === "api_key" ? "secret" : "default",
      enabled: true,
    })),
    _postman_variable_scope: "environment",
  };
}

function convertCollection(document, sourcePath, collectionVersion) {
  const description = [
    document.meta?.description,
    `Generated from ${sourcePath}. Edit the Insomnia source and run npm run postman:generate.`,
  ]
    .filter(Boolean)
    .join("\n\n");
  const collection = {
    info: {
      name: document.name ?? basename(sourcePath),
      description,
      version: collectionVersion,
      schema: POSTMAN_COLLECTION_SCHEMA,
    },
    item: (document.collection ?? []).map(convertNode),
  };

  if (document.environments?.data) {
    collection.variable = Object.entries(document.environments.data).map(
      ([key, value]) => ({ key, value: value ?? "", type: "string" }),
    );
  }

  return collection;
}

function convertNode(node) {
  if (node.method && node.url) {
    return convertRequest(node);
  }

  const folder = {
    name: node.name ?? "Unnamed folder",
    item: (node.children ?? []).map(convertNode),
  };
  if (node.meta?.description) {
    folder.description = node.meta.description;
  }
  const auth = convertAuthentication(node.authentication);
  if (auth) {
    folder.auth = auth;
  }
  const events = convertScripts(node.scripts);
  if (events.length > 0) {
    folder.event = events;
  }
  return folder;
}

function convertRequest(node) {
  const request = {
    method: String(node.method).toUpperCase(),
    header: (node.headers ?? []).map((header) => ({
      key: header.name,
      value: normalizeVariables(header.value ?? ""),
      type: "text",
      ...(header.disabled ? { disabled: true } : {}),
    })),
    url: {
      raw: normalizeVariables(node.url),
    },
  };

  if (node.meta?.description) {
    request.description = node.meta.description;
  }
  const auth = convertAuthentication(node.authentication);
  if (auth) {
    request.auth = auth;
  }
  const body = convertBody(node.body);
  if (body) {
    request.body = body;
  }

  const item = {
    name: node.name ?? "Unnamed request",
    request,
  };
  const events = convertScripts(node.scripts);
  if (events.length > 0) {
    item.event = events;
  }
  return item;
}

function convertAuthentication(authentication) {
  if (!authentication) {
    return undefined;
  }
  if (authentication.type === "none") {
    return { type: "noauth" };
  }
  if (authentication.type === "bearer") {
    return {
      type: "bearer",
      bearer: [
        {
          key: "token",
          value: normalizeVariables(authentication.token ?? ""),
          type: "string",
        },
      ],
    };
  }
  throw new Error(
    `Unsupported Insomnia authentication type: ${authentication.type}`,
  );
}

function convertBody(body) {
  if (!body) {
    return undefined;
  }
  if (body.mimeType === "application/json") {
    return {
      mode: "raw",
      raw: normalizeVariables(body.text ?? ""),
      options: { raw: { language: "json" } },
    };
  }
  if (body.mimeType === "multipart/form-data") {
    return {
      mode: "formdata",
      formdata: (body.params ?? []).map((part) => {
        if (part.type === "file") {
          return {
            key: part.name,
            type: "file",
            src: normalizeVariables(part.fileName ?? ""),
            ...(part.disabled ? { disabled: true } : {}),
          };
        }
        return {
          key: part.name,
          value: normalizeVariables(part.value ?? ""),
          type: "text",
          ...(part.disabled ? { disabled: true } : {}),
        };
      }),
    };
  }
  throw new Error(`Unsupported Insomnia request body type: ${body.mimeType}`);
}

function convertScripts(scripts) {
  const events = [];
  if (scripts?.preRequest) {
    events.push(convertScriptEvent("prerequest", scripts.preRequest));
  }
  if (scripts?.afterResponse) {
    events.push(convertScriptEvent("test", scripts.afterResponse));
  }
  return events;
}

function convertScriptEvent(listen, source) {
  return {
    listen,
    script: {
      type: "text/javascript",
      exec: convertScript(source).split("\n"),
    },
  };
}

function convertScript(source) {
  return source
    .replaceAll("insomnia.environment.", "pm.environment.")
    .replaceAll("insomnia.globals.", "pm.environment.")
    .replaceAll("insomnia.variables.", "pm.variables.")
    .replaceAll("insomnia.response.", "pm.response.")
    .replaceAll("insomnia.test(", "pm.test(")
    .replaceAll("insomnia.expect(", "pm.expect(");
}

function normalizeVariables(value) {
  return String(value).replace(/\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g, "{{$1}}");
}

function walkFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const filePath = join(directory, entry.name);
    return entry.isDirectory() ? walkFiles(filePath) : [filePath];
  });
}
