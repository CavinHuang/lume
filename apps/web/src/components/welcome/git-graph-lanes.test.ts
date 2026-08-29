import { describe, expect, test } from 'bun:test'
import { computeGitGraphLayout } from './git-graph-lanes'

describe('computeGitGraphLayout', () => {
  test('线性历史复用同一泳道', () => {
    const layout = computeGitGraphLayout([
      { hash: 'a', parents: ['b'] },
      { hash: 'b', parents: ['c'] },
      { hash: 'c', parents: [] },
    ])
    expect(layout.laneCount).toBe(1)
    expect(layout.rows.map((row) => row.lane)).toEqual([0, 0, 0])
    expect(layout.rows[0]!.outEdges).toEqual([{ from: 0, to: 0 }])
    expect(layout.rows.map((row) => row.transit)).toEqual([[], [], []])
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
    expect(layout.laneCount).toBe(2)
    // d 占泳道 0；第一父 b 继承泳道 0，第二父 c 并入已期望 c 的泳道 1
    expect(layout.rows[0]!.lane).toBe(0)
    expect(layout.rows[0]!.outEdges).toEqual([
      { from: 0, to: 0 },
      { from: 0, to: 1 },
    ])
    // b 行：泳道 1（期望 c）直穿
    expect(layout.rows[1]!.lane).toBe(0)
    expect(layout.rows[1]!.transit).toEqual([1])
    // c 行命中泳道 1
    expect(layout.rows[2]!.lane).toBe(1)
  })

  test('截断历史的悬空父提交占新槽不越界', () => {
    const layout = computeGitGraphLayout([
      { hash: 'x', parents: ['missing-parent'] },
    ])
    expect(layout.rows[0]!.outEdges).toEqual([{ from: 0, to: 0 }])
    expect(layout.rows[0]!.lane).toBe(0)
  })
})
