import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp";
import { z } from "zod";

export function registerTest(mcpServer: McpServer): void {
    mcpServer.registerTool(
         "add",
        {
            description: "两个数字相加",
            inputSchema: z.object({
                a: z.number(),
                b: z.number()
            })
        },
        async ({ a, b }) => {
            console.log('createMcpServer',a,b)
            return {
                content: [
                    {
                        type: "text",
                        text: `${a + b}`
                    }
                ]
            };

        }
    );
}
