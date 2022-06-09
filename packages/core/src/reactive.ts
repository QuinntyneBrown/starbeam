import {
  type ReactiveInternals,
  type ReactiveProtocol,
  REACTIVE,
} from "@starbeam/timeline";

export interface Reactive<T> extends ReactiveProtocol {
  readonly current: T;
}

export const Reactive = {
  internals(reactive: ReactiveProtocol): ReactiveInternals {
    return reactive[REACTIVE];
  },
};
