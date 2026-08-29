/**
 * Git 图谱泳道布局：按 git log（date-order）顺序为每条提交分配泳道，
 * 产出每行的直行线、提交节点位置与指向父提交的出边，供 SVG 绘制。
 */

export interface GitGraphEdge {
  from: number
  to: number
}

export interface GitGraphRow {
  hash: string
  /** 提交节点所在泳道 */
  lane: number
  /** 从本行顶部直穿到底部的既有泳道（不含提交自身泳道） */
  transit: number[]
  /** 从提交节点延伸到行底部的边（指向父提交所在泳道） */
  outEdges: GitGraphEdge[]
}

export interface GitGraphLayout {
  rows: GitGraphRow[]
  laneCount: number
}

/**
 * 泳道分配：lanes[i] 存"该泳道下一个期望出现的 hash"。
 * - 命中期望的提交复用该泳道；否则占用首个空槽/追加新槽。
 * - 第一父提交优先继承提交自身泳道；其余父提交并入已有期望泳道或开新槽。
 */
export function computeGitGraphLayout(commits: Array<{ hash: string; parents: string[] }>): GitGraphLayout {
  const lanes: Array<string | null> = []
  const rows: GitGraphRow[] = []

  for (const commit of commits) {
    let lane = lanes.indexOf(commit.hash)
    if (lane >= 0) {
      lanes[lane] = null
    } else {
      lane = lanes.indexOf(null)
      if (lane < 0) {
        lanes.push(null)
        lane = lanes.length - 1
      } else {
        lanes[lane] = null
      }
    }

    const transit: number[] = []
    for (let index = 0; index < lanes.length; index += 1) {
      if (index !== lane && lanes[index] !== null) transit.push(index)
    }

    const outEdges: GitGraphEdge[] = []
    for (const parent of commit.parents) {
      const existing = lanes.indexOf(parent)
      if (existing >= 0) {
        outEdges.push({ from: lane, to: existing })
        continue
      }
      let slot = lanes.indexOf(null)
      if (slot < 0) {
        lanes.push(null)
        slot = lanes.length - 1
      }
      lanes[slot] = parent
      outEdges.push({ from: lane, to: slot })
    }

    rows.push({ hash: commit.hash, lane, transit, outEdges })
  }

  return { rows, laneCount: lanes.length }
}
