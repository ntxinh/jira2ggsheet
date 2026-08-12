// Vitest-only stub for the workerd-injected module 'cloudflare:workers' (wired via resolve.alias
// in vitest.config.ts). SyncCoordinator extends DurableObject to enable RPC in the real runtime;
// tests instantiate it directly, so the stub just needs to hold ctx/env like the real base class.
export class DurableObject<Env = unknown> {
  protected ctx: DurableObjectState
  protected env: Env

  constructor(ctx: DurableObjectState, env: Env) {
    this.ctx = ctx
    this.env = env
  }
}
