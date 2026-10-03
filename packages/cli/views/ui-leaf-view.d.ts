/**
 * `@openthink/ui-leaf/view` is not a package export: the ui-leaf binary serves it when it bundles a view, so
 * npm has no `.d.ts` for it. This mirrors ui-leaf's own `packages/cli/src/view.ts` (v1.6) so the view's `.tsx`
 * type-checks (AGT-1295: the old editor's never did).
 */
declare module "@openthink/ui-leaf/view" {
  export type Mutate = <TResult = unknown>(name: string, args?: unknown) => Promise<TResult>;
  export interface ViewProps<TData = unknown> {
    /** Whatever the host passed as `data` to mount(). */
    data: TData;
    /** Invoke a mutation handler the host registered. */
    mutate: Mutate;
  }
}
