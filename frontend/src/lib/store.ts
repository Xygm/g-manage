import { useCallback, useRef, useSyncExternalStore } from "react";

/** 极简外部状态：组件按选择器订阅，只在自己关心的那一片变化时才重渲染（2FA 每 30 秒刷新不会拖动整张列表）。 */
export interface Store<T> {
  get: () => T;
  set: (patch: Partial<T> | ((s: T) => Partial<T>)) => void;
  subscribe: (fn: () => void) => () => void;
}

export function createStore<T extends object>(init: T): Store<T> {
  let state = init;
  const subs = new Set<() => void>();
  return {
    get: () => state,
    set(patch) {
      const next = typeof patch === "function" ? patch(state) : patch;
      state = { ...state, ...next };
      subs.forEach((fn) => fn());
    },
    subscribe(fn) {
      subs.add(fn);
      return () => subs.delete(fn);
    },
  };
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (typeof v !== "object" || v === null) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

export function shallowEqual<A>(a: A, b: A): boolean {
  if (Object.is(a, b)) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!Object.is(a[i], b[i])) return false;
    }
    return true;
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    for (const k of ka) {
      if (!Object.is(a[k], b[k])) return false;
    }
    return true;
  }
  return false;
}

export function useStore<T extends object, S>(
  store: Store<T>,
  selector: (s: T) => S,
  equal: (a: S, b: S) => boolean = shallowEqual,
): S {
  const selRef = useRef(selector);
  const eqRef = useRef(equal);
  selRef.current = selector;
  eqRef.current = equal;

  const last = useRef<{ has: boolean; v: S }>({ has: false, v: undefined as S });
  const get = useCallback(() => {
    const v = selRef.current(store.get());
    if (last.current.has && eqRef.current(last.current.v, v)) {
      return last.current.v;
    }
    last.current = { has: true, v };
    return v;
  }, [store]);

  return useSyncExternalStore(store.subscribe, get, get);
}
