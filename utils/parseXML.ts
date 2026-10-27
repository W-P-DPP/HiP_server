import xml2js from "xml2js";

export const parseXML = async (xml: string): Promise<any> => {
  return new Promise((resolve, reject) => {
    xml2js.parseString(
      xml,
      { explicitArray: false, trim: true },
      (err, result) => {
        if (err) {
          reject(err);
        } else {
          resolve(result);
        }
      }
    );
  });
};
