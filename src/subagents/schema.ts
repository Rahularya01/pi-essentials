const MAX_SCHEMA_BYTES = 32 * 1024;
const MAX_SCHEMA_DEPTH = 16;
const MAX_SCHEMA_NODES = 1_000;
const DANGEROUS_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const JSON_SCHEMA_TYPES = new Set(["null", "boolean", "object", "array", "number", "integer", "string"]);
const SCHEMA_MAP_KEYS = new Set(["properties", "patternProperties", "$defs", "definitions", "dependentSchemas"]);
const SCHEMA_ARRAY_KEYS = new Set(["allOf", "anyOf", "oneOf", "prefixItems"]);
const SCHEMA_VALUE_KEYS = new Set([
  "additionalProperties", "unevaluatedProperties", "items", "contains", "not", "if", "then", "else",
  "propertyNames", "unevaluatedItems",
]);

export type JsonSchema = Record<string, unknown>;

/** Validate and clone an untrusted TypeBox/JSON schema before embedding it in a child extension. */
export function validateOutputSchema(value: unknown): JsonSchema {
  if (!isPlainObject(value)) throw new Error("outputSchema must be a plain JSON object.");

  let nodes = 0;
  const count = (depth: number): void => {
    if (depth > MAX_SCHEMA_DEPTH) throw new Error(`outputSchema exceeds the maximum depth of ${MAX_SCHEMA_DEPTH}.`);
    if (++nodes > MAX_SCHEMA_NODES) throw new Error(`outputSchema exceeds the maximum size of ${MAX_SCHEMA_NODES} values.`);
  };

  const visitJson = (item: unknown, depth: number): void => {
    count(depth);
    if (item === null || typeof item === "string" || typeof item === "boolean") return;
    if (typeof item === "number" && Number.isFinite(item)) return;
    if (Array.isArray(item)) {
      for (const child of item) visitJson(child, depth + 1);
      return;
    }
    if (!isPlainObject(item)) throw new Error("outputSchema may contain only JSON values and plain objects.");
    for (const [key, child] of Object.entries(item)) {
      if (DANGEROUS_KEYS.has(key)) throw new Error(`outputSchema contains unsafe key "${key}".`);
      visitJson(child, depth + 1);
    }
  };

  const visitSchema = (item: unknown, depth: number, location: string): void => {
    count(depth);
    if (typeof item === "boolean") return;
    if (!isPlainObject(item)) throw new Error(`outputSchema ${location} must be a schema object or boolean.`);

    const type = item.type;
    if (type !== undefined) {
      const types = Array.isArray(type) ? type : [type];
      if (types.length === 0 || types.some((entry) => typeof entry !== "string" || !JSON_SCHEMA_TYPES.has(entry))) {
        throw new Error(`outputSchema ${location} has an invalid type keyword.`);
      }
    }
    if (item.required !== undefined && (!Array.isArray(item.required) || item.required.some((entry) => typeof entry !== "string"))) {
      throw new Error(`outputSchema ${location} required must be an array of property names.`);
    }
    if (item.pattern !== undefined) {
      if (typeof item.pattern !== "string") throw new Error(`outputSchema ${location} pattern must be a string.`);
      try { new RegExp(item.pattern); } catch { throw new Error(`outputSchema ${location} has an invalid pattern.`); }
    }
    if (item.$ref !== undefined && (typeof item.$ref !== "string" || !item.$ref.startsWith("#/$defs/"))) {
      throw new Error("outputSchema supports only local $ref values under #/$defs/.");
    }

    for (const [key, child] of Object.entries(item)) {
      if (DANGEROUS_KEYS.has(key)) throw new Error(`outputSchema contains unsafe key "${key}".`);
      if (SCHEMA_MAP_KEYS.has(key)) {
        if (!isPlainObject(child)) throw new Error(`outputSchema ${key} must be an object.`);
        count(depth + 1);
        for (const [name, schema] of Object.entries(child)) {
          if (DANGEROUS_KEYS.has(name)) throw new Error(`outputSchema contains unsafe key "${name}".`);
          visitSchema(schema, depth + 2, `${key}.${name}`);
        }
      } else if (SCHEMA_ARRAY_KEYS.has(key)) {
        if (!Array.isArray(child) || child.length === 0) throw new Error(`outputSchema ${key} must be a non-empty array.`);
        for (const schema of child) visitSchema(schema, depth + 1, key);
      } else if (SCHEMA_VALUE_KEYS.has(key)) {
        if (key === "items" && Array.isArray(child)) {
          for (const schema of child) visitSchema(schema, depth + 1, key);
        } else {
          visitSchema(child, depth + 1, key);
        }
      } else {
        // Annotation and assertion values (enum, const, defaults, numeric limits,
        // custom extension keywords) are JSON data, not necessarily schemas.
        visitJson(child, depth + 1);
      }
    }
  };

  visitSchema(value, 0, "root");
  if (value.type !== "object") throw new Error('outputSchema must describe an object at its root (type: "object").');
  const json = JSON.stringify(value);
  if (Buffer.byteLength(json, "utf8") > MAX_SCHEMA_BYTES) {
    throw new Error(`outputSchema exceeds the maximum encoded size of ${MAX_SCHEMA_BYTES} bytes.`);
  }
  return JSON.parse(json) as JsonSchema;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function effectiveOutputSchema(taskSchema: unknown, rootSchema: unknown): JsonSchema | undefined {
  const selected = taskSchema === undefined ? rootSchema : taskSchema;
  return selected === undefined ? undefined : validateOutputSchema(selected);
}
