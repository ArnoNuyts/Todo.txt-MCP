
async function rpc(method: string, params?: any) {
  const response = await fetch("http://localhost:3001/mcp", {
    method: "POST",
    headers: { 
      "Content-Type": "application/json",
      "Accept": "application/json, text/event-stream"
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: Math.floor(Math.random() * 1000),
      method: "tools/call",
      params: {
        name: method,
        arguments: params || {},
      },
    }),
  });
  return await response.json();
}

async function main() {
  console.log("Starting verification...");

  // 1. Add Todo
  console.log("Adding todo...");
  const addRes = await rpc("add_todo", { text: "Test Hash Todo" });
  if (addRes.error) {
    console.error("Add failed:", addRes.error);
    Deno.exit(1);
  }
  console.log("Add result:", addRes.result.content[0].text);
  
  // Extract hash from add result if possible, or list to find it
  // The add_todo tool returns: Added todo [HASH]: ...
  const addText = addRes.result.content[0].text;
  const hashMatch = addText.match(/\[([0-9a-f]+)\]/);
  let hash = hashMatch ? hashMatch[1] : null;

  if (!hash) {
      console.log("Could not extract hash from add result, listing todos...");
      const listRes = await rpc("list_todos");
      const listText = listRes.result.content[0].text;
      const lines = listText.split("\n");
      const line = lines.find(l => l.includes("Test Hash Todo"));
      if (line) {
          const match = line.match(/\[([0-9a-f]+)\]/);
          if (match) hash = match[1];
      }
  }

  if (!hash) {
      console.error("Could not find hash for new todo");
      Deno.exit(1);
  }
  console.log("Target Hash:", hash);

  // 2. Edit Todo
  console.log("Editing todo...");
  const editRes = await rpc("edit_todo", { hash: hash, text: "Test Hash Todo Edited" });
  if (editRes.error) {
      console.error("Edit failed:", editRes.error);
      Deno.exit(1);
  }
  console.log("Edit result:", editRes.result.content[0].text);
  
  // Update hash after edit
  const editText = editRes.result.content[0].text;
  const editHashMatch = editText.match(/\[([0-9a-f]+)\]/);
  if (editHashMatch) {
      hash = editHashMatch[1];
      console.log("New Hash after edit:", hash);
  }

  // 3. Mark Done
  console.log("Marking done...");
  const doneRes = await rpc("set_todo_status", { hash: hash, status: "done" });
  if (doneRes.error) {
      console.error("Mark done failed:", doneRes.error);
      Deno.exit(1);
  }
  console.log("Mark done result:", doneRes.result.content[0].text);

  // Update hash after mark done
  const doneText = doneRes.result.content[0].text;
  const doneHashMatch = doneText.match(/\[([0-9a-f]+)\]/);
  if (doneHashMatch) {
      hash = doneHashMatch[1];
      console.log("New Hash after mark done:", hash);
  }

  // 4. Verify state
  console.log("Verifying state...");
  const verifyRes = await rpc("list_todos");
  const verifyText = verifyRes.result.content[0].text;
  if (verifyText.includes(`[${hash}] x `) && verifyText.includes("Test Hash Todo Edited")) {
      console.log("SUCCESS: Todo verified as done and edited.");
  } else {
      console.error("FAILURE: State mismatch.");
      console.log("Current list:\n", verifyText);
      Deno.exit(1);
  }
}

main();
