import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";

interface CreateProcessorRpcClientOptions {
  baseUrl: string;
  getSecret?: () => string | Promise<string> | undefined;
}

export function createProcessorRpcClient(options: CreateProcessorRpcClientOptions): unknown {
  const link = new RPCLink({
    url: `${options.baseUrl}/rpc`,
    headers: async () => {
      const secret = await options.getSecret?.();
      return secret ? { Authorization: `Processor ${secret}` } : {};
    },
  });

  return createORPCClient(link);
}
