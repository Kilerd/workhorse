import { endpointRegistry, type EndpointSpec, type SchemaName } from "./api.js";
import { schemaRegistry } from "./validators.js";

type JsonSchema = Record<string, unknown>;

interface OpenApiDocument {
  openapi: string;
  info: {
    title: string;
    version: string;
    description: string;
  };
  servers: Array<{ url: string }>;
  tags: Array<{ name: string }>;
  paths: Record<string, Record<string, unknown>>;
  components: {
    schemas: Record<string, unknown>;
  };
}

interface TypiaSchemaBundle {
  version?: string;
  components?: {
    schemas?: Record<string, unknown>;
  };
  schema?: unknown;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cloneAndNormalizeSchema(
  schema: unknown,
  components: Record<string, unknown>
): unknown {
  if (Array.isArray(schema)) {
    return schema.map((item) => cloneAndNormalizeSchema(item, components));
  }

  if (!isObject(schema)) {
    return schema;
  }

  const next: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(schema)) {
    if (key === "$defs" && isObject(value)) {
      for (const [definitionName, definitionSchema] of Object.entries(value)) {
        if (!(definitionName in components)) {
          components[definitionName] = cloneAndNormalizeSchema(
            definitionSchema,
            components
          );
        }
      }
      continue;
    }

    if (key === "$ref" && typeof value === "string") {
      next.$ref = value.replace(
        "#/$defs/",
        "#/components/schemas/"
      );
      continue;
    }

    if (key === "$schema") {
      continue;
    }

    if (key === "const") {
      next.enum = [value];
      continue;
    }

    next[key] = cloneAndNormalizeSchema(value, components);
  }

  return next;
}

function collectSchemas(): Record<string, unknown> {
  const components: Record<string, unknown> = {};

  for (const [name, factory] of Object.entries(schemaRegistry)) {
    const bundle = factory() as unknown as TypiaSchemaBundle;
    const bundledSchemas = bundle.components?.schemas ?? {};

    for (const [schemaName, schemaValue] of Object.entries(bundledSchemas)) {
      if (!(schemaName in components)) {
        components[schemaName] = cloneAndNormalizeSchema(schemaValue, components);
      }
    }

    if (!(name in components)) {
      components[name] = cloneAndNormalizeSchema(bundle.schema ?? {}, components);
    }
  }

  return components;
}

function createRef(name: SchemaName): JsonSchema {
  return {
    $ref: `#/components/schemas/${name}`
  };
}

function schemaToParameters(
  location: "path" | "query",
  schemaName?: SchemaName
): JsonSchema[] {
  if (!schemaName) {
    return [];
  }

  const bundle = schemaRegistry[schemaName]() as unknown as TypiaSchemaBundle;
  const schema =
    bundle.components?.schemas?.[schemaName] ?? bundle.schema ?? {};
  const normalized = cloneAndNormalizeSchema(schema, {}) as JsonSchema;
  const properties = isObject(normalized.properties)
    ? normalized.properties
    : {};
  const requiredSet = new Set(
    Array.isArray(normalized.required)
      ? normalized.required.filter((value): value is string => typeof value === "string")
      : []
  );

  return Object.entries(properties).map(([name, propertySchema]) => ({
    name,
    in: location,
    required: location === "path" ? true : requiredSet.has(name),
    schema: propertySchema
  }));
}

function buildPathItem(endpoint: EndpointSpec): Record<string, unknown> {
  const parameters = [
    ...schemaToParameters("path", endpoint.paramsSchema),
    ...schemaToParameters("query", endpoint.querySchema)
  ];

  const responses = Object.fromEntries(
    endpoint.responses.map((response) => [
      String(response.status),
      {
        description: response.description,
        content: {
          "application/json": {
            schema: createRef(response.schema)
          }
        }
      }
    ])
  );

  const operation: Record<string, unknown> = {
    operationId: endpoint.operationId,
    summary: endpoint.summary,
    tags: [endpoint.tag],
    responses
  };

  if (parameters.length > 0) {
    operation.parameters = parameters;
  }

  if (endpoint.bodySchema) {
    operation.requestBody = {
      required: true,
      content: {
        "application/json": {
          schema: createRef(endpoint.bodySchema)
        }
      }
    };
  }

  return {
    [endpoint.method]: operation
  };
}

export function buildOpenApiDocument(): OpenApiDocument {
  const paths: Record<string, Record<string, unknown>> = {};

  for (const endpoint of endpointRegistry) {
    const existing = paths[endpoint.path] ?? {};
    paths[endpoint.path] = {
      ...existing,
      ...buildPathItem(endpoint)
    };
  }

  return {
    openapi: "3.0.3",
    info: {
      title: "Workhorse API",
      version: "0.1.0",
      description:
        "Local-first runtime API for the Workhorse multi-workspace kanban."
    },
    servers: [
      {
        url: "http://127.0.0.1:3999"
      }
    ],
    tags: [
      { name: "Runtime" },
      { name: "Settings" },
      { name: "Workspaces" },
      { name: "Tasks" },
      { name: "Runs" }
    ],
    paths,
    components: {
      schemas: collectSchemas()
    }
  };
}
