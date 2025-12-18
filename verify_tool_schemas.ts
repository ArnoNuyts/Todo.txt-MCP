interface JsonSchemaProperty {
  type?: string;
  description?: string;
  enum?: (string | number | boolean | null)[];
  properties?: { [key: string]: JsonSchemaProperty };
  items?: JsonSchemaProperty;
}

async function rpc(method: string, params?: unknown) {
  const response = await fetch("http://localhost:3001/mcp", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Accept": "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: Math.floor(Math.random() * 1000),
      method: method,
      params: params || {},
    }),
  });
  return await response.json();
}

async function main() {
  console.log("Verifying MCP tool schemas...\n");

  // List all tools
  const toolsResponse = await rpc("tools/list");

  if (!toolsResponse.result || !toolsResponse.result.tools) {
    console.error("FAIL: No tools found in response");
    console.log(JSON.stringify(toolsResponse, null, 2));
    return;
  }

  const tools = toolsResponse.result.tools;
  console.log(`Found ${tools.length} tools\n`);

  let allPassed = true;

  for (const tool of tools) {
    console.log(`\n=== Tool: ${tool.name} ===`);

    // Check if tool has inputSchema
    if (!tool.inputSchema) {
      console.error(`FAIL: Tool '${tool.name}' has no inputSchema`);
      allPassed = false;
      continue;
    }

    console.log(`Description: ${tool.description || "(none)"}`);
    console.log(`Input Schema Type: ${tool.inputSchema.type}`);

    // Check if inputSchema has properties
    if (tool.inputSchema.type === "object" && tool.inputSchema.properties) {
      console.log(`Properties:`);
      for (
        const [propName, propSchema] of Object.entries(
          tool.inputSchema.properties,
        )
      ) {
        const schema: JsonSchemaProperty = propSchema;
        console.log(`  - ${propName}:`);
        console.log(`      type: ${schema.type || "(not specified)"}`);
        console.log(`      description: ${schema.description || "(MISSING)"}`);

        if (!schema.description) {
          console.error(
            `    ⚠️  FAIL: Property '${propName}' has no description`,
          );
          allPassed = false;
        } else {
          console.log(`    ✓ PASS: Has description`);
        }

        // Check for enum values
        if (schema.enum) {
          console.log(`      enum: [${schema.enum.join(", ")}]`);
        }
      }
    } else {
      console.log(`Properties: (none or not an object schema)`);
    }

    // Check required fields
    if (tool.inputSchema.required && tool.inputSchema.required.length > 0) {
      console.log(`Required: [${tool.inputSchema.required.join(", ")}]`);
    }
  }

  console.log("\n" + "=".repeat(50));
  if (allPassed) {
    console.log("✓ ALL TESTS PASSED: All tool properties have descriptions");
  } else {
    console.error(
      "✗ SOME TESTS FAILED: Some properties are missing descriptions",
    );
  }
}

main();
