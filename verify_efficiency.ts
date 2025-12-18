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
  console.log("Starting efficiency verification...");

  // 1. Setup: Add some todos
  console.log("Adding test todos...");
  await rpc("add_todo", { text: "Active Task 1" });
  await rpc("add_todo", { text: "Active Task 2" });
  await rpc("add_todo", { text: "x Done Task 1" });
  await rpc("add_todo", { text: "x Done Task 2" });
  await rpc("add_todo", { text: "UniqueSearchTerm Task" });

  // 2. Test Default (Status=todo)
  console.log("\nTesting Default (Status=todo)...");
  const defaultRes = await rpc("list_todos", {});
  const defaultText = defaultRes.result.content[0].text;
  if (
    defaultText.includes("Active Task 1") &&
    !defaultText.includes("Done Task 1")
  ) {
    console.log("PASS: Default shows active only");
  } else {
    console.error("FAIL: Default filtering incorrect");
    console.log(defaultText);
  }

  // 3. Test Status=done
  console.log("\nTesting Status=done...");
  const doneRes = await rpc("list_todos", { status: "done" });
  const doneText = doneRes.result.content[0].text;
  if (!doneText.includes("Active Task 1") && doneText.includes("Done Task 1")) {
    console.log("PASS: Status=done shows done only");
  } else {
    console.error("FAIL: Status=done filtering incorrect");
    console.log(doneText);
  }

  // 4. Test Search
  console.log("\nTesting Search...");
  const searchRes = await rpc("list_todos", { search: "UniqueSearchTerm" });
  const searchText = searchRes.result.content[0].text;
  if (
    searchText.includes("UniqueSearchTerm") &&
    !searchText.includes("Active Task 1")
  ) {
    console.log("PASS: Search filtering correct");
  } else {
    console.error("FAIL: Search filtering incorrect");
    console.log(searchText);
  }

  // 5. Test Pagination
  console.log("\nTesting Pagination (Limit=1)...");
  const pageRes = await rpc("list_todos", { limit: 1 });
  const pageText = pageRes.result.content[0].text;
  const lines = pageText.split("\n").filter((l: string) => l.trim() !== "");
  if (lines.length === 1) {
    console.log("PASS: Pagination limit correct");
  } else {
    console.error(
      `FAIL: Pagination limit incorrect (got ${lines.length} lines)`,
    );
    console.log(pageText);
  }
}

main();
