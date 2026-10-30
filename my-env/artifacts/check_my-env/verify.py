"""Checks the environment, served from the state the capture observed, through its MCP endpoint: the tool count and one answered status."""
import json

from mcp import ClientSession
from mcp.client.streamable_http import streamable_http_client

TOOL_COUNT = 5
TOOL = "get_folders"
EXPECTED_STATUS = 200


def answered_status(result):
    """The status member of a tool result, structured or from its text content."""
    data = result.structuredContent
    if data is None:
        text = "".join(getattr(part, "text", "") for part in result.content)
        data = json.loads(text) if text else {}
    return data.get("status") if isinstance(data, dict) else None


async def verify(mcp_url):
    async with streamable_http_client(mcp_url) as (read, write, _):
        async with ClientSession(read, write) as session:
            await session.initialize()
            listed = await session.list_tools()
            result = await session.call_tool(TOOL, {}) if TOOL is not None else None
    count = len(listed.tools)
    passed = count == TOOL_COUNT
    description = f"listed {count} tools, expected {TOOL_COUNT}"
    if result is not None:
        status = None if result.isError else answered_status(result)
        passed = passed and not result.isError and status == EXPECTED_STATUS
        description += f"; {TOOL} answered status {status!r}, expected {EXPECTED_STATUS!r}"
    else:
        description += "; no GET tool without path parameters answers without arguments"
    print(f"serve: {description}")
    return [{"id": "serve", "result": passed, "description": description}]
