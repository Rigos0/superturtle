import imageCompression from "browser-image-compression";
import swal from "@sweetalert/with-react";

const FILE_NAME_LIMIT = 20;

const MAX_IMAGE_UPLOAD_SIZE = 2; // MEGA-BYTES

const MAX_VIDEO_UPLOAD_SIZE = 10; // MEGA-BYTES

const ACCEPTED_IMAGE_FORMATS = ["png", "jpg", "jpeg", "gif"];

const ACCEPTED_VIDEO_FORMATS = ["mp4", "mkv", "3gp", "avi", "webm"];

const fileNameCompressor = (fileName) => {
  let outputFileName = fileName;
  const arr = fileName.split(".");
  const name = arr[0];
  const ext = arr[arr.length - 1];

  if (name.length > FILE_NAME_LIMIT) {
    outputFileName = name.substring(0, FILE_NAME_LIMIT).trim() + "... ." + ext;
  }
  return outputFileName;
};

const readFileAsDataURL = (file) =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = (event) => {
      const result = event?.target?.result;
      if (typeof result === "string") {
        resolve(result);
        return;
      }

      reject(new Error("Unable to read file"));
    };
    reader.onerror = () => reject(new Error("Unable to read file"));
    reader.readAsDataURL(file);
  });

const compressImageFile = async (inputFile) => {
  const compressionOptions = {
    maxSizeMB: 1,
    maxWidthOrHeight: 1920,
    useWebWorker: true,
  };

  return await imageCompression(inputFile, compressionOptions);
};

export const imageUploadHandler = async (
  e,
  type,
  setUploadData,
  options = {},
) => {
  const inputFiles = Array.from(e.target.files ?? []);
  const maxImageCount = options.maxImageCount ?? 4;

  if (inputFiles.length === 0) {
    return;
  }

  try {
    if (type === "video") {
      const inputFile = inputFiles[0];
      const [inputFileType = "", inputFileExt = ""] = inputFile.type.split("/");
      const inputFileName = fileNameCompressor(inputFile.name);
      const fileSize = inputFile.size / (1024 * 1024);

      if (inputFileType !== "video" || !ACCEPTED_VIDEO_FORMATS.includes(inputFileExt)) {
        swal("Invalid Video Format",`Please select video format of ${ACCEPTED_VIDEO_FORMATS.map(format=> format+' ')}`,"warning");
        return;
      }

      if (fileSize > MAX_VIDEO_UPLOAD_SIZE) {
        swal("Video Too Large", `Please select a video less than ${MAX_VIDEO_UPLOAD_SIZE}MB file size`,"warning");
        return;
      }

      const fileData = await readFileAsDataURL(inputFile);
      setUploadData((previousValue) => ({
        ...previousValue,
        files: [
          {
            type: "video",
            name: inputFileName,
            data: fileData,
            blob: null,
          },
        ],
      }));
      return;
    }

    if (type !== "image") {
      swal("Invalid File Format", "warning");
      return;
    }

    const normalizedImageFiles = [];

    for (const inputFile of inputFiles) {
      const [inputFileType = "", inputFileExt = ""] = inputFile.type.split("/");
      const inputFileName = fileNameCompressor(inputFile.name);
      const fileSize = inputFile.size / (1024 * 1024);

      if (inputFileType !== "image" || !ACCEPTED_IMAGE_FORMATS.includes(inputFileExt)) {
        swal("Invalid Image Format",`Please select an image format of ${ACCEPTED_IMAGE_FORMATS.map(format=> format+' ')}`,"warning");
        continue;
      }

      if (fileSize > MAX_IMAGE_UPLOAD_SIZE) {
        swal("Image Too Large", `Please select an image less than ${MAX_IMAGE_UPLOAD_SIZE}MB file size`,"warning");
        continue;
      }

      let compressedInputFile;
      try {
        compressedInputFile = await compressImageFile(inputFile);
      } catch (error) {
        console.error("Failed to compress image:", error);
        continue;
      }

      const fileData = await readFileAsDataURL(compressedInputFile);
      normalizedImageFiles.push({
        type: "image",
        name: inputFileName,
        data: fileData,
        blob: compressedInputFile,
      });
    }

    if (normalizedImageFiles.length === 0) {
      return;
    }

    setUploadData((previousValue) => {
      const existingImages = (previousValue.files ?? []).filter(
        (file) => file.type === "image",
      );
      const mergedImages = [...existingImages, ...normalizedImageFiles];

      return {
        ...previousValue,
        files: mergedImages.slice(0, maxImageCount),
      };
    });
  } finally {
    // clear the file input event value
    e.target.value = "";
  }
};
