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

export const imageUploadHandler = async (e, type, uploadData, setUploadData) => {
  const inputFile = e.target.files[0];
  const _inputFile = inputFile.type.split("/");
  const inputFileType = _inputFile[0];
  const inputFileExec = _inputFile[1];
  const inputFileName = fileNameCompressor(inputFile.name);

  const fileSize = inputFile.size / (1024 * 1024);

  switch (type) {
    case "video":
      if (!ACCEPTED_VIDEO_FORMATS.some((format) => format.includes(inputFileExec))) {
        swal("Invalid Video Format",`Please select video format of ${ACCEPTED_VIDEO_FORMATS.map(format=> format+' ')}`,"warning");
        e.target.value = "";
        return;
      }
      if (fileSize > MAX_VIDEO_UPLOAD_SIZE) {
        swal("Video Too Large", `Please select a video less than ${MAX_VIDEO_UPLOAD_SIZE}MB file size`,"warning");
        e.target.value = "";
        return;
      }
      break;
    case "image":
      if (!ACCEPTED_IMAGE_FORMATS.some((format) => format.includes(inputFileExec))) {
        swal("Invalid Image Format",`Please select an image format of ${ACCEPTED_IMAGE_FORMATS.map(format=> format+' ')}`,"warning");
        e.target.value = "";
        return;
      }
      if (fileSize > MAX_IMAGE_UPLOAD_SIZE) {
        swal("Image Too Large", `Please select an image less than ${MAX_IMAGE_UPLOAD_SIZE}MB file size`,"warning");
        e.target.value = "";
        return;
      }
      break;
    default:
      swal("Invalid File Format", "warning");
      e.target.value = "";
      return;
  }

  let compressedInputFile = inputFile;
  if (inputFileType === "image") {
    //compression algorithm
    const compressionOptions = {
      maxSizeMB: 1,
      maxWidthOrHeight: 1920,
      useWebWorker: true,
    };

    try {
      compressedInputFile = await imageCompression(inputFile, compressionOptions);
    } catch (error) {
      alert(error);
    }
  }

  let inputFileDataBase64;
  const file = new FileReader();
  if (compressedInputFile) {
    file.onloadend = (fileLoadedEvent) => {
      inputFileDataBase64 = fileLoadedEvent.target.result;
      setUploadData({
        ...uploadData,
        file: {
          type: inputFileType,
          name: inputFileName,
          data: inputFileDataBase64,
        },
      });
    };
    file.readAsDataURL(compressedInputFile);
  }

  // clear the file input event value
  e.target.value = "";
};
