/**
 * Git 图谱泳道分配：按 git log（date-order）顺序为每条提交分配泳道，
 * 泳道 x 坐标即提交节点的横向位置，边的绘制由调用方按行距连线。
 */

export interface GitGraphLayout {
  /** 每条提交所在泳道（与输入顺序一一对应） */
  lanes: number[]
  laneCount: number
}

/**
 * lanes[i] 存"该泳道下一个期望出现的 hash"：
 * - 命中期望的提交复用该泳道；否则占用首个空槽/追加新槽。
 * - 第一父提交优先继承提交自身泳道；其余父提交并入已有期望泳道或开新槽。
 */
export function computeGitGraphLayout(commits: Array<{ hash: string; parents: string[] }>): GitGraphLayout {
  const lanes: Array<string | null> = []
  const result: number[] = []

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

    for (const parent of commit.parents) {
      if (lanes.includes(parent)) continue
      const slot = lanes.indexOf(null)
      if (slot < 0) lanes.push(parent)
      else lanes[slot] = parent
    }

    result.push(lane)
  }

  return { lanes: result, laneCount: lanes.length }
}
