import { UnsafeAny } from "starbeam";
import {
  AnyPattern,
  Pattern,
  PatternImpl,
  PatternMatch,
  PatternMismatch,
  PatternResult,
} from "../expect";
import { Failure, NotEqual, PatternDetails, Success } from "../report";

export interface ToBeDescription {
  actual: string;
  expected: string;
}

export class ToBe<T> implements Pattern<unknown, T, undefined> {
  constructor(readonly value: T, readonly description?: ToBeDescription) {}

  readonly details: PatternDetails = {
    name: "toBe",
    description: "Object.is equality",
  };

  check(actual: unknown): PatternResult<undefined> {
    if (Object.is(this.value, actual)) {
      return PatternMatch();
    } else {
      return PatternMismatch();
    }
  }

  success(): Success {
    if (this.description) {
      let { actual, expected } = this.description;
      return Success({
        pattern: this.details,
        message: `${actual} was equal to ${expected}`,
      });
    } else {
      return Success({ pattern: this.details, message: "were equal" });
    }
  }

  failure(actual: unknown): Failure {
    if (this.description) {
      return NotEqual({
        actual: this.description.actual,
        expected: this.description.expected,
        pattern: this.details,
      });
    } else {
      return NotEqual({ actual, expected: this.value, pattern: this.details });
    }
  }
}

export function toBe<T>(
  value: T,
  description?: ToBeDescription
): AnyPattern<T> {
  return PatternImpl.of<T, T, UnsafeAny, UnsafeAny>(
    new ToBe(value, description)
  );
}
