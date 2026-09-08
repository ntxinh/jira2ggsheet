import { Inngest, Middleware } from 'inngest'
import type { Env } from '../config'

class WorkersBindingsMiddleware extends Middleware.BaseMiddleware {
  id = 'workers-bindings'
  private env!: Env

  async wrapRequest({ next, requestArgs }: Middleware.WrapRequestArgs) {
    this.env = requestArgs[1] as Env
    return await next()
  }

  transformFunctionInput(args: Middleware.TransformFunctionInputArgs) {
    return {
      ...args,
      ctx: {
        ...args.ctx,
        env: this.env,
      },
    }
  }
}

export const inngest = new Inngest({
  id: 'jira2ggsheet',
  middleware: [WorkersBindingsMiddleware],
})
