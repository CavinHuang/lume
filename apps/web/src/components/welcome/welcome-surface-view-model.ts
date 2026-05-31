export interface BuildWelcomeSurfaceViewModelInput {
  workspaceName: string | null
}

export interface WelcomeSurfaceHero {
  title: string
  subtitle: string
}

export interface WelcomeSurfaceViewModel {
  hero: WelcomeSurfaceHero
}

export function buildWelcomeSurfaceViewModel({
  workspaceName,
}: BuildWelcomeSurfaceViewModelInput): WelcomeSurfaceViewModel {
  return {
    hero: {
      title: '今天想一起完成什么？',
      subtitle: workspaceName
        ? `在「${workspaceName}」中开始新的工作流`
        : '在当前工作区中开始新的工作流',
    },
  }
}
