declare module "qrcode" {
  export interface ToStringOptions {
    type?: "svg" | "utf8" | "terminal";
    width?: number;
    margin?: number;
    errorCorrectionLevel?: "L" | "M" | "Q" | "H";
  }

  const QRCode: {
    toString(value: string, options?: ToStringOptions): Promise<string>;
  };

  export default QRCode;
}
