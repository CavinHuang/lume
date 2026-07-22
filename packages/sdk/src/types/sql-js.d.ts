declare module "sql.js" {
  const initSqlJs: (config?: Record<string, unknown>) => Promise<any>;
  export default initSqlJs;
}
