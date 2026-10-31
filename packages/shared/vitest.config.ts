import { taijiTestConfig } from '../../test-guard/factory.ts'

export default taijiTestConfig({
  test: {
    // src/execution/**：执行域契约测试基线（M0）。设计契约族按目录自包含放置
    //（同目录测试），不并进 src/__tests__/——执行域是独立限界上下文，
    // 测试与被测契约同目录便于 u-m1+ 波次沿同一目录扩展。
    include: ['__tests__/**/*.test.ts', 'src/__tests__/**/*.test.ts', 'src/execution/**/*.test.ts'],
  },
})
