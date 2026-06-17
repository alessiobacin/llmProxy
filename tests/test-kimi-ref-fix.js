const { sanitizeToolsForMoonshot, sanitizeSchemaForMoonshot } = require('./lib/copilot-proxy.js');

// Test schema with deeply nested $ref
const testSchema = {
  type: "object",
  properties: {
    filters: {
      type: "object",
      properties: {
        $and: {
          type: "array",
          items: {
            type: "object",
            properties: {
              tags: {
                $ref: "#/definitions/TagFilter"
              },
              messages: {
                $ref: "MessageFilter"
              },
              nested: {
                $ref: "#/definitions/NestedSchema"
              }
            }
          }
        }
      }
    }
  },
  definitions: {
    TagFilter: {
      type: "string",
      enum: ["tag1", "tag2"]
    },
    NestedSchema: {
      type: "object",
      properties: {
        value: { type: "string" }
      }
    }
  }
};

console.log("=== Original schema ===");
console.log(JSON.stringify(testSchema, null, 2));

const sanitized = sanitizeSchemaForMoonshot(testSchema);

console.log("\n=== Sanitized schema ===");
console.log(JSON.stringify(sanitized, null, 2));

// Check all $ref values
function checkAllRefs(obj, path = "") {
  if (Array.isArray(obj)) {
    obj.forEach((item, i) => checkAllRefs(item, `${path}[${i}]`));
  } else if (obj && typeof obj === "object") {
    if ("$ref" in obj) {
      const ref = obj.$ref;
      const isValid = ref.startsWith("#/$defs/");
      console.log(`${isValid ? '✓' : '❌'} ${path}.$ref = "${ref}" ${isValid ? '' : '(INVALID!)'}`);
      if (!isValid) {
        console.log(`   Fixed: "${ref}" -> "#/$defs/${ref}"`);
      }
    }
    Object.entries(obj).forEach(([key, value]) => {
      if (key !== "$ref") {
        checkAllRefs(value, `${path}.${key}`);
      }
    });
  }
}

console.log("\n=== Checking all $ref values ===");
checkAllRefs(sanitized, "root");

// Test with tools
const testTools = [
  {
    type: "function",
    function: {
      name: "test_function",
      description: "Test function",
      parameters: testSchema
    }
  }
];

const sanitizedTools = sanitizeToolsForMoonshot(testTools);

console.log("\n=== Sanitized tools ===");
console.log(JSON.stringify(sanitizedTools, null, 2));

console.log("\n=== Checking all $ref in sanitized tools ===");
checkAllRefs(sanitizedTools, "tools");
