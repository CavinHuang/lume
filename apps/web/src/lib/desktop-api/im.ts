import { IM_IPC_CHANNELS } from '@lume/shared'
import type {
  CliAuthPollInput,
  CliAuthPollResult,
  CliAuthStartInput,
  CliAuthStartResult,
  ImAccount,
  ImAccountCreateInput,
  ImAccountUpdateInput,
  ImMirrorEntryPublic,
  ImMirrorSettingsPublic,
  ImWeixinLoginPollInput,
  ImWeixinLoginPollResult,
  ImWeixinLoginStartInput,
  ImWeixinLoginStartResult,
} from '@lume/shared'
import { sidecarCall } from './system'

export const listImAccounts = () =>
  sidecarCall<ImAccount[]>(IM_IPC_CHANNELS.LIST_ACCOUNTS, {})

export const createImAccount = (input: ImAccountCreateInput) =>
  sidecarCall<ImAccount>(IM_IPC_CHANNELS.CREATE_ACCOUNT, input)

export const updateImAccount = (id: string, input: ImAccountUpdateInput) =>
  sidecarCall<ImAccount>(IM_IPC_CHANNELS.UPDATE_ACCOUNT, { id, input })

export const deleteImAccount = (id: string) =>
  sidecarCall<{ ok: true }>(IM_IPC_CHANNELS.DELETE_ACCOUNT, { id })

// ─── #544 会话镜像 ───

export const getImMirrorSettings = () =>
  sidecarCall<ImMirrorSettingsPublic>(IM_IPC_CHANNELS.MIRROR_GET_SETTINGS, {})

export const setImMirrorOwner = (accountId: string | null) =>
  sidecarCall<{ ok: boolean; error?: string; settings: ImMirrorSettingsPublic }>(
    IM_IPC_CHANNELS.MIRROR_SET_OWNER,
    { accountId },
  )

export const listImMirrors = () =>
  sidecarCall<{ entries: ImMirrorEntryPublic[]; titles: Record<string, string> }>(
    IM_IPC_CHANNELS.MIRROR_LIST,
    {},
  )

export const startImAccount = (id: string) =>
  sidecarCall<ImAccount | { ok: true }>(IM_IPC_CHANNELS.START_ACCOUNT, { id })

export const stopImAccount = (id: string) =>
  sidecarCall<ImAccount | { ok: true }>(IM_IPC_CHANNELS.STOP_ACCOUNT, { id })

export const startWeixinLogin = (input: ImWeixinLoginStartInput = {}) =>
  sidecarCall<ImWeixinLoginStartResult>(IM_IPC_CHANNELS.START_WEIXIN_LOGIN, input)

export const pollWeixinLogin = (input: ImWeixinLoginPollInput) =>
  sidecarCall<ImWeixinLoginPollResult>(IM_IPC_CHANNELS.POLL_WEIXIN_LOGIN, input)

export const startCliAuth = (input: CliAuthStartInput) =>
  sidecarCall<CliAuthStartResult>(IM_IPC_CHANNELS.START_CLI_AUTH, input)

export const pollCliAuth = (input: CliAuthPollInput) =>
  sidecarCall<CliAuthPollResult>(IM_IPC_CHANNELS.POLL_CLI_AUTH, input)

export const cancelCliAuth = (input: CliAuthPollInput) =>
  sidecarCall<{ ok: true }>(IM_IPC_CHANNELS.CANCEL_CLI_AUTH, input)
