# @zhushanwen/state-machine

## 0.2.1

### Patch Changes

- d2b945a20: `MachineCore` 删除无消费方的 `eventSet` / `rows` 导出字段（同一查询由 `rowIndex` / `legalEvents` 承担），构建与转移判定行为不变。

## 0.2.0

### Minor Changes

- df839883b: First release of `@zhushanwen/state-machine`: declarative finite state machine infrastructure for pi extensions — literal-typed state/event vocabularies with definition-time self-checks, a pure transition kernel (guards evaluated in order, multi-match throws, planned-vs-applied two-phase actions, `errorPolicy: 'throw' | 'result'`), `coerceState` whitelist mapping, a transactional `runTransition` orchestration shell (actions run in planned order, next state applied only if all succeed), and an exhaustive transition-table test generator.
