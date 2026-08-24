import type { JsonSchema } from "./types";

const optionalSchemas = new WeakSet<object>();

/**
 * Options shared by primitive JSON Schema helper functions.
 */
export type JsonSchemaOptions = {
  description?: string;
  default?: unknown;
  format?: string;
};

type ObjectOptions = JsonSchemaOptions & {
  required?: string[];
  optional?: readonly string[];
  additionalProperties?: boolean | JsonSchema;
  defs?: Record<string, JsonSchema>;
};

type ArrayOptions = JsonSchemaOptions & {
  minItems?: number;
  maxItems?: number;
  uniqueItems?: boolean;
  itemDescription?: string;
};

type StringOptions = JsonSchemaOptions & {
  minLength?: number;
  maxLength?: number;
  pattern?: string;
};

type NumberOptions = JsonSchemaOptions & {
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: number;
};

/**
 * JSON Schema helpers for provider action contracts.
 *
 * Provider definitions should use these helpers for common schema shapes and
 * drop to plain JSON Schema objects only for provider-specific edge cases.
 */
export const jsonSchema = {
  object(
    propertiesOrDescription: Record<string, JsonSchema> | string,
    optionsOrProperties: ObjectOptions | Record<string, JsonSchema> = {},
    maybeOptions: ObjectOptions = {},
  ): JsonSchema {
    const properties =
      typeof propertiesOrDescription === "string"
        ? (optionsOrProperties as Record<string, JsonSchema>)
        : propertiesOrDescription;
    const options =
      typeof propertiesOrDescription === "string"
        ? { ...maybeOptions, description: propertiesOrDescription }
        : (optionsOrProperties as ObjectOptions);
    const required =
      options.required ??
      (options.optional
        ? Object.keys(properties).filter(
            (key) => !options.optional?.includes(key) && !optionalSchemas.has(properties[key]!),
          )
        : Object.values(properties).some((schema) => optionalSchemas.has(schema))
          ? Object.keys(properties).filter((key) => !optionalSchemas.has(properties[key]!))
          : undefined);
    const schema: JsonSchema = {
      type: "object",
      properties,
      additionalProperties: options.additionalProperties ?? false,
    };
    if (required && required.length > 0) schema.required = required;
    if (options.defs) schema.$defs = options.defs;
    return withOptions(schema, options);
  },

  requiredObject(description: string, properties: Record<string, JsonSchema>): JsonSchema {
    return this.object(properties, {
      required: Object.keys(properties).filter((key) => !optionalSchemas.has(properties[key]!)),
      description,
    });
  },

  array(
    itemsOrDescription: JsonSchema | string,
    optionsOrItems: ArrayOptions | JsonSchema = {},
    maybeOptions: ArrayOptions = {},
  ): JsonSchema {
    const items = typeof itemsOrDescription === "string" ? (optionsOrItems as JsonSchema) : itemsOrDescription;
    const options =
      typeof itemsOrDescription === "string"
        ? { ...maybeOptions, description: itemsOrDescription }
        : (optionsOrItems as ArrayOptions);
    const schema: JsonSchema = { type: "array", items };
    withOptions(schema, options);
    if (options.minItems != null) schema.minItems = options.minItems;
    if (options.maxItems != null) schema.maxItems = options.maxItems;
    if (options.uniqueItems != null) schema.uniqueItems = options.uniqueItems;
    return schema;
  },

  string(
    optionsOrDescription: StringOptions | string = {},
    maybeOptions: Omit<StringOptions, "description"> = {},
  ): JsonSchema {
    const options =
      typeof optionsOrDescription === "string"
        ? { ...maybeOptions, description: optionsOrDescription }
        : optionsOrDescription;
    const schema: JsonSchema = { type: "string" };
    if (options.minLength != null) schema.minLength = options.minLength;
    if (options.maxLength != null) schema.maxLength = options.maxLength;
    withOptions(schema, options);
    if (options.pattern != null) schema.pattern = options.pattern;
    return schema;
  },

  nonEmptyString(description: string, options: Omit<StringOptions, "description" | "minLength"> = {}): JsonSchema {
    return this.string({ ...options, minLength: 1, description });
  },

  url(description: string): JsonSchema {
    return this.string({ format: "uri", description });
  },

  nullableString(description: string, options: Omit<JsonSchemaOptions, "description"> = {}): JsonSchema {
    return this.nullable(this.string({ ...options, description }));
  },

  nullableInteger(description: string, options: Omit<NumberOptions, "description"> = {}): JsonSchema {
    return this.nullable(this.integer({ ...options, description }));
  },

  dateTime(description: string): JsonSchema {
    return this.string({ format: "date-time", description });
  },

  date(description: string): JsonSchema {
    return this.string({ format: "date", description });
  },

  stringEnum(
    valuesOrDescription: readonly string[] | string,
    optionsOrValues: JsonSchemaOptions | readonly string[] = {},
  ): JsonSchema {
    const values =
      typeof valuesOrDescription === "string" ? (optionsOrValues as readonly string[]) : valuesOrDescription;
    const options =
      typeof valuesOrDescription === "string"
        ? { description: valuesOrDescription }
        : (optionsOrValues as JsonSchemaOptions);
    return withOptions({ type: "string", enum: values }, options);
  },

  integer(
    optionsOrDescription: NumberOptions | string = {},
    maybeOptions: Omit<NumberOptions, "description"> = {},
  ): JsonSchema {
    const options =
      typeof optionsOrDescription === "string"
        ? { ...maybeOptions, description: optionsOrDescription }
        : optionsOrDescription;
    const schema: JsonSchema = { type: "integer" };
    if (options.minimum != null) schema.minimum = options.minimum;
    if (options.maximum != null) schema.maximum = options.maximum;
    if (options.exclusiveMinimum != null) schema.exclusiveMinimum = options.exclusiveMinimum;
    return withOptions(schema, options);
  },

  positiveInteger(description: string, options: Omit<NumberOptions, "description" | "minimum"> = {}): JsonSchema {
    return this.integer({ ...options, minimum: 1, description });
  },

  boolean(optionsOrDescription: JsonSchemaOptions | string = {}): JsonSchema {
    const options =
      typeof optionsOrDescription === "string" ? { description: optionsOrDescription } : optionsOrDescription;
    return withOptions({ type: "boolean" }, options);
  },

  literal(value: string | number | boolean, options: JsonSchemaOptions = {}): JsonSchema {
    return withOptions({ const: value, type: typeof value }, options);
  },

  union(schemas: JsonSchema[], options: JsonSchemaOptions = {}): JsonSchema {
    return withOptions({ anyOf: schemas }, options);
  },

  nullable(schema: JsonSchema): JsonSchema {
    return { anyOf: [schema, { type: "null" }] };
  },

  record(
    valuesOrDescription: JsonSchema | boolean | string,
    optionsOrValues: JsonSchemaOptions | JsonSchema | boolean = {},
  ): JsonSchema {
    const values =
      typeof valuesOrDescription === "string" ? (optionsOrValues as JsonSchema | boolean) : valuesOrDescription;
    const options =
      typeof valuesOrDescription === "string"
        ? { description: valuesOrDescription }
        : (optionsOrValues as JsonSchemaOptions);
    return withOptions({ type: "object", additionalProperties: values }, options);
  },
};

function cloneSchema(schema: JsonSchema, properties: Partial<JsonSchema>): JsonSchema {
  const clone = { ...schema, ...properties };
  if (optionalSchemas.has(schema)) optionalSchemas.add(clone);
  return clone;
}

/**
 * Short alias for provider schema definitions.
 */
export const s: typeof jsonSchema = jsonSchema;

function withOptions(schema: JsonSchema, options: JsonSchemaOptions): JsonSchema {
  if (options.description) schema.description = options.description;
  if (options.default !== undefined) schema.default = options.default;
  if (options.format) schema.format = options.format;
  return schema;
}
