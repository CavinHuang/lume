import { describe, expect, test } from 'bun:test'
import { computeGitGraphLayout } from './git-graph-lanes'

describe('computeGitGraphLayout', () => {
  test('线性历史复用同一泳道', () => {
    const layout = computeGitGraphLayout([
      { hash: 'a', parents: ['b'] },
      { hash: 'b', parents: ['c'] },
      { hash: 'c', parents: [] },
    ])
    expect(layout.lanes).toEqual([0, 0, 0])
    expect(layout.laneCount).toBe(1)
  })

  test('分支提交开新泳道并回合流', () => {
    // a —— b —— d(merge)
    //       \c -/
    const layout = computeGitGraphLayout([
      { hash: 'd', parents: ['b', 'c'] },
      { hash: 'b', parents: ['a'] },
      { hash: 'c', parents: ['a'] },
      { hash: 'a', parents: [] },
    ])
    // d 占泳道 0；b 继承泳道 0；c 命中泳道 1；a 合回泳道 0
    expect(layout.lanes).toEqual([0, 0, 1, 0])
    expect(layout.laneCount).toBe(2)
  })

  test('第二父提交并入已有期望泳道时不开新槽', () => {
    const layout = computeGitGraphLayout([
      { hash: 'm', parents: ['x', 'a'] },
      { hash: 'a', parents: [] },
      { hash: 'x', parents: ['a'] },
    ])
    // m 占泳道 0，第一父 x 入槽 0，第二父 a 入槽 1；a 行命中槽 1
    expect(layout.lanes).toEqual([0, 1, 0])
    expect(layout.laneCount).toBe(2)
  })

  test('截断历史的悬空父提交占新槽不越界', () => {
    const layout = computeGitGraphLayout([
      { hash: 'x', parents: ['missing-parent'] },
    ])
    expect(layout.lanes).toEqual([0])
  })
})
