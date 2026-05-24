import { IM_IPC_CHANNELS } from '@lume/shared'
import type {
  ImAccount,
  ImAccountCreateInput,
  ImAccountUpdateInput,
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

export const startImAccount = (id: string) =>
  sidecarCall<ImAccount | { ok: true }>(IM_IPC_CHANNELS.START_ACCOUNT, { id })

export const stopImAccount = (id: string) =>
  sidecarCall<ImAccount | { ok: true }>(IM_IPC_CHANNELS.STOP_ACCOUNT, { id })

export const startWeixinLogin = (input: ImWeixinLoginStartInput = {}) =>
  sidecarCall<ImWeixinLoginStartResult>(IM_IPC_CHANNELS.START_WEIXIN_LOGIN, input)

export const pollWeixinLogin = (input: ImWeixinLoginPollInput) =>
  sidecarCall<ImWeixinLoginPollResult>(IM_IPC_CHANNELS.POLL_WEIXIN_LOGIN, input)
