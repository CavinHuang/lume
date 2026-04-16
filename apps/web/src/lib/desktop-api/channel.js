import { sidecarCall } from './system';
export const listChannels = () => sidecarCall('channel:list', {});
export const createChannel = (input) => sidecarCall('channel:create', input);
export const updateChannel = (id, input) => sidecarCall('channel:update', { id, ...input });
export const deleteChannel = (id) => sidecarCall('channel:delete', { id });
export const decryptChannelKey = (id) => sidecarCall('channel:decrypt-key', { id });
export const fetchChannelModels = (input) => sidecarCall('channel:fetch-models', input);
