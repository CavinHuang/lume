const fsPromises = require("node:fs/promises");

const originalUnlink = fsPromises.unlink.bind(fsPromises);

fsPromises.unlink = async function retryingUnlink(path, ...rest) {
  let attempt = 0;
  while (true) {
    try {
      return await originalUnlink(path, ...rest);
    } catch (error) {
      if ((error?.code !== "EBUSY" && error?.code !== "EPERM") || attempt >= 9) {
        throw error;
      }
      attempt += 1;
      await new Promise((resolve) => setTimeout(resolve, attempt * 200));
    }
  }
};
