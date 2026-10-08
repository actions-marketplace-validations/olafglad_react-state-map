import type { StateType } from '../types.js';

export interface HookSpec {
  type: StateType;
  library: string;
  /** First argument is a React context (useContext(Ctx), use(Ctx)) */
  contextArg?: boolean;
  /** Only valid in Client Components (React Server Components rules) */
  clientOnly?: boolean;
  /** Returns [value, setter] tuple */
  tuple?: boolean;
}

/** React hooks that never represent state — skipped entirely */
export const IGNORED_REACT_HOOKS = new Set([
  'useEffect', 'useLayoutEffect', 'useInsertionEffect', 'useMemo', 'useCallback', 'useRef',
  'useImperativeHandle', 'useDebugValue', 'useDeferredValue', 'useTransition', 'useId',
  'useEffectEvent',
]);

/** Client-only React hooks (for Server Component checks) */
export const CLIENT_ONLY_REACT_HOOKS = new Set([
  'useState', 'useReducer', 'useContext', 'useEffect', 'useLayoutEffect', 'useInsertionEffect',
  'useRef', 'useImperativeHandle', 'useTransition', 'useDeferredValue', 'useSyncExternalStore',
  'useActionState', 'useOptimistic', 'useFormStatus', 'useEffectEvent',
]);

const REACT: Record<string, HookSpec> = {
  useState: { type: 'useState', library: 'react', clientOnly: true, tuple: true },
  useReducer: { type: 'useReducer', library: 'react', clientOnly: true, tuple: true },
  useContext: { type: 'useContext', library: 'react', contextArg: true, clientOnly: true },
  use: { type: 'useContext', library: 'react', contextArg: true },
  useActionState: { type: 'useActionState', library: 'react', clientOnly: true, tuple: true },
  useFormState: { type: 'useActionState', library: 'react-dom', clientOnly: true, tuple: true },
  useOptimistic: { type: 'useOptimistic', library: 'react', clientOnly: true, tuple: true },
  useSyncExternalStore: { type: 'externalStore', library: 'react', clientOnly: true },
  useFormStatus: { type: 'form', library: 'react-dom', clientOnly: true },
};

/** Hooks identified by exact name, keyed by library */
const BY_LIBRARY: Record<string, Record<string, HookSpec>> = {
  redux: {
    useSelector: { type: 'redux', library: 'redux', clientOnly: true },
    useDispatch: { type: 'redux', library: 'redux', clientOnly: true },
    useStore: { type: 'redux', library: 'redux', clientOnly: true },
  },
  zustand: {
    useStore: { type: 'zustand', library: 'zustand', clientOnly: true },
  },
  'tanstack-query': {
    useQuery: { type: 'serverState', library: 'tanstack-query', clientOnly: true },
    useSuspenseQuery: { type: 'serverState', library: 'tanstack-query', clientOnly: true },
    useInfiniteQuery: { type: 'serverState', library: 'tanstack-query', clientOnly: true },
    useSuspenseInfiniteQuery: { type: 'serverState', library: 'tanstack-query', clientOnly: true },
    useQueries: { type: 'serverState', library: 'tanstack-query', clientOnly: true },
    useSuspenseQueries: { type: 'serverState', library: 'tanstack-query', clientOnly: true },
    useMutation: { type: 'serverState', library: 'tanstack-query', clientOnly: true },
    useMutationState: { type: 'serverState', library: 'tanstack-query', clientOnly: true },
    useIsFetching: { type: 'serverState', library: 'tanstack-query', clientOnly: true },
    useIsMutating: { type: 'serverState', library: 'tanstack-query', clientOnly: true },
  },
  apollo: {
    useQuery: { type: 'serverState', library: 'apollo', clientOnly: true },
    useLazyQuery: { type: 'serverState', library: 'apollo', clientOnly: true },
    useSuspenseQuery: { type: 'serverState', library: 'apollo', clientOnly: true },
    useBackgroundQuery: { type: 'serverState', library: 'apollo', clientOnly: true },
    useReadQuery: { type: 'serverState', library: 'apollo', clientOnly: true },
    useMutation: { type: 'serverState', library: 'apollo', clientOnly: true },
    useSubscription: { type: 'serverState', library: 'apollo', clientOnly: true },
    useFragment: { type: 'serverState', library: 'apollo', clientOnly: true },
    useReactiveVar: { type: 'externalStore', library: 'apollo', clientOnly: true },
  },
  urql: {
    useQuery: { type: 'serverState', library: 'urql', clientOnly: true },
    useMutation: { type: 'serverState', library: 'urql', clientOnly: true },
    useSubscription: { type: 'serverState', library: 'urql', clientOnly: true },
  },
  swr: {
    useSWR: { type: 'serverState', library: 'swr', clientOnly: true },
    useSWRInfinite: { type: 'serverState', library: 'swr', clientOnly: true },
    useSWRMutation: { type: 'serverState', library: 'swr', clientOnly: true },
    useSWRSubscription: { type: 'serverState', library: 'swr', clientOnly: true },
  },
  jotai: {
    useAtom: { type: 'atom', library: 'jotai', clientOnly: true, tuple: true },
    useAtomValue: { type: 'atom', library: 'jotai', clientOnly: true },
    useSetAtom: { type: 'atom', library: 'jotai', clientOnly: true },
  },
  recoil: {
    useRecoilState: { type: 'atom', library: 'recoil', clientOnly: true, tuple: true },
    useRecoilValue: { type: 'atom', library: 'recoil', clientOnly: true },
    useSetRecoilState: { type: 'atom', library: 'recoil', clientOnly: true },
    useRecoilStateLoadable: { type: 'atom', library: 'recoil', clientOnly: true, tuple: true },
    useRecoilValueLoadable: { type: 'atom', library: 'recoil', clientOnly: true },
    useResetRecoilState: { type: 'atom', library: 'recoil', clientOnly: true },
  },
  valtio: {
    useSnapshot: { type: 'externalStore', library: 'valtio', clientOnly: true },
    useProxy: { type: 'externalStore', library: 'valtio', clientOnly: true },
  },
  xstate: {
    useMachine: { type: 'machine', library: 'xstate', clientOnly: true, tuple: true },
    useActor: { type: 'machine', library: 'xstate', clientOnly: true, tuple: true },
    useActorRef: { type: 'machine', library: 'xstate', clientOnly: true },
    useInterpret: { type: 'machine', library: 'xstate', clientOnly: true },
    useSelector: { type: 'machine', library: 'xstate', clientOnly: true },
  },
  'react-hook-form': {
    useForm: { type: 'form', library: 'react-hook-form', clientOnly: true },
    useFormContext: { type: 'form', library: 'react-hook-form', clientOnly: true },
    useWatch: { type: 'form', library: 'react-hook-form', clientOnly: true },
    useController: { type: 'form', library: 'react-hook-form', clientOnly: true },
    useFieldArray: { type: 'form', library: 'react-hook-form', clientOnly: true },
    useFormState: { type: 'form', library: 'react-hook-form', clientOnly: true },
  },
  router: {
    useParams: { type: 'router', library: 'router', clientOnly: true },
    useSearchParams: { type: 'router', library: 'router', clientOnly: true },
    useLocation: { type: 'router', library: 'router', clientOnly: true },
    useNavigate: { type: 'router', library: 'router', clientOnly: true },
    useNavigation: { type: 'router', library: 'router', clientOnly: true },
    useRouter: { type: 'router', library: 'router', clientOnly: true },
    usePathname: { type: 'router', library: 'router', clientOnly: true },
    useLoaderData: { type: 'router', library: 'router', clientOnly: true },
    useActionData: { type: 'router', library: 'router', clientOnly: true },
    useRouteLoaderData: { type: 'router', library: 'router', clientOnly: true },
    useMatch: { type: 'router', library: 'router', clientOnly: true },
    useMatches: { type: 'router', library: 'router', clientOnly: true },
    useSelectedLayoutSegment: { type: 'router', library: 'router', clientOnly: true },
    useSelectedLayoutSegments: { type: 'router', library: 'router', clientOnly: true },
    useSearch: { type: 'router', library: 'router', clientOnly: true },
    useRouterState: { type: 'router', library: 'router', clientOnly: true },
  },
};

/** Maps an import source to a library key in BY_LIBRARY */
export function libraryForModule(specifier: string): string | null {
  if (specifier === 'react' || specifier === 'react-dom') return 'react';
  if (specifier === 'react-redux' || specifier.startsWith('@reduxjs/toolkit')) return 'redux';
  if (specifier === 'zustand' || specifier.startsWith('zustand/')) return 'zustand';
  if (specifier === '@tanstack/react-query' || specifier === 'react-query') return 'tanstack-query';
  if (specifier.startsWith('@apollo/client')) return 'apollo';
  if (specifier === 'urql' || specifier === '@urql/next') return 'urql';
  if (specifier === 'swr' || specifier.startsWith('swr/')) return 'swr';
  if (specifier === 'jotai' || specifier.startsWith('jotai/')) return 'jotai';
  if (specifier === 'recoil') return 'recoil';
  if (specifier === 'valtio' || specifier.startsWith('valtio/')) return 'valtio';
  if (specifier === '@xstate/react' || specifier === 'xstate') return 'xstate';
  if (specifier === 'react-hook-form') return 'react-hook-form';
  if (
    specifier === 'react-router' ||
    specifier === 'react-router-dom' ||
    specifier === '@remix-run/react' ||
    specifier === '@tanstack/react-router' ||
    specifier === 'next/navigation' ||
    specifier === 'next/router' ||
    specifier === 'wouter'
  ) return 'router';
  return null;
}

/**
 * Classify a hook call that is NOT defined in the analyzed project.
 * @param name Hook name with any namespace prefix stripped (React.useState → useState)
 * @param importSource Module the hook was imported from, if known
 */
export function classifyHook(name: string, importSource: string | null): HookSpec | null {
  if (IGNORED_REACT_HOOKS.has(name)) return null;

  const library = importSource ? libraryForModule(importSource) : null;

  if (library === 'react' || (!importSource && REACT[name])) {
    const spec = REACT[name];
    if (spec) return spec;
  }

  if (library && library !== 'react') {
    const spec = BY_LIBRARY[library]?.[name];
    if (spec) return spec;
  }

  // RTK Query generated hooks: useGetPostsQuery, useLazyGetPostsQuery, useAddPostMutation
  if (/^use(Lazy)?[A-Z]\w*(Query|Mutation)$/.test(name) && !BY_LIBRARY['tanstack-query']![name]) {
    return { type: 'serverState', library: 'rtk-query', clientOnly: true };
  }

  // Typed Redux hooks: useAppSelector, useTypedSelector, useAppDispatch
  if (/^use\w*Selector$/.test(name) && name !== 'useSelector') {
    return { type: 'redux', library: 'redux', clientOnly: true };
  }
  if (/^use\w*Dispatch$/.test(name) && name !== 'useDispatch') {
    return { type: 'redux', library: 'redux', clientOnly: true };
  }

  // Zustand convention: useBearStore, useAuthStore
  if (/^use[A-Z]\w*Store$/.test(name)) {
    return { type: 'zustand', library: 'zustand', clientOnly: true };
  }

  // Unknown import source (or library re-exported locally) — fall back to name-based lookup
  if (!library) {
    if (name === 'useSelector' || name === 'useDispatch') return BY_LIBRARY.redux![name]!;
    if (name === 'useStore') return BY_LIBRARY.zustand!.useStore!;
    for (const lib of ['tanstack-query', 'swr', 'jotai', 'recoil', 'valtio', 'xstate', 'react-hook-form', 'router']) {
      const spec = BY_LIBRARY[lib]?.[name];
      if (spec) return spec;
    }
  }

  return null;
}

export function isHookName(name: string): boolean {
  return /^use[A-Z0-9]/.test(name) || name === 'use';
}
