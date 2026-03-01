import { makeStyles } from "@material-ui/core/styles";
import { darkSecondary, LinkedInBlue, LinkedInLightBlue } from "../../assets/Colors";

export default makeStyles((theme) => ({
  upload: {
    width: "100%",
    height: "auto",
    display: "flex",
    flexDirection: "column",
    padding: "0 10px",
    borderRadius: 8,
    [theme.breakpoints.down("xs")]: {
      borderRadius: 0,
      border: 0,
      boxShadow: "none",
    },
  },

  upload__header: {
    height: "auto",
    display: "flex",
    alignItems: "center",
    padding: "15px 0 5px 0",
  },

  header__form: {
    flex: 1,
    height: 47,
    [theme.breakpoints.down("xs")]: {
      height: 42,
    },
    display: "flex",
    alignItems: "center",
    borderRadius: 999,
    border: "1px solid",
    borderColor: theme.palette.type === "dark" ? "rgba(225,225,225,0.1)" : "rgba(0,0,0,0.15)",
    overflow: "hidden",
    "& > .MuiSvgIcon-root": {
      marginLeft: 10,
    },
    "& > input": {
      height: "100%",
      flex: 1,
      border: 0,
      outlineWidth: 0,
      paddingLeft: 10,
      color: theme.palette.type === "dark" && "lightgrey",
      fontSize: 14,
      fontWeight: 600,
      backgroundColor: "transparent",
      "&::placeholder": {
        color: theme.palette.type === "dark" && "grey",
      },
    },
    "& > button": {
      height: "100%",
      display: "flex",
      alignItems: "center",
      padding: "0 15px",
      border: 0,
      outlineWidth: 0,
      backgroundColor: theme.palette.type === "dark" ? LinkedInLightBlue : LinkedInBlue,
      color: "white",
      cursor: "pointer",
      fontWeight: 600,
      transition: "all 0.4s ease",
      "&:hover": {
        backgroundColor: theme.palette.type === "dark" ? LinkedInBlue : LinkedInLightBlue,
      },
    },
  },

  selectedFile: {
    display: "flex",
    alignItems: "center",
    paddingBottom: 5,
  },

  uploading: {
    display: "flex",
    alignItems: "center",
    margin: "5px 0",
    paddingLeft: 5,
    "& > p": {
      fontSize: 12,
      fontWeight: 600,
    },
  },

  pasteURL_Input: {
    width: "50%",
    [theme.breakpoints.down("xs")]: {
      width: "80%",
    },
    height: 30,
    display: "flex",
    justifyContent: "center",
    alignItems: "center",
    margin: "10px auto",
    borderBottom:
      theme.palette.type === "dark"
        ? "1px dashed rgba(225,225,225,0.1)"
        : "1px dashed rgba(0,0,0,0.15)",

    "& > input": {
      flex: 1,
      height: "100%",
      outlineWidth: 0,
      backgroundColor: "transparent",
      border: 0,
      overflow: "hidden",
      padding: "0px 10px",
      color: theme.palette.type === "dark" ? "lightgrey" : "grey",
      fontSize: 13,
      "&::placeholder": {
        color: theme.palette.type === "dark" && "grey",
      },
    },

    "& > .MuiSvgIcon-root": {
      margin: "2px 0px",
    },
  },

  progress: {
    flex: 1,
    height: 8,
    marginRight: 5,
    borderRadius: 10,
    backgroundColor: theme.palette.type === "dark" ? darkSecondary : "lightgrey",
    "& > *": {
      backgroundColor: theme.palette.type === "dark" ? LinkedInLightBlue : LinkedInBlue,
    },
  },

  upload__media: {
    height: 50,
    [theme.breakpoints.down("xs")]: {
      height: 40,
    },
    display: "flex",
    alignItems: "center",
    padding: "2px 0",
    opacity: 0.8,
  },

  media__options: {
    flex: 1,
    height: "100%",
    display: "flex",
    justifyContent: "center",
    alignItems: "center",
    cursor: "pointer",
    borderRadius: 4,
    transition: "all 0.4s ease",
    "&:hover": {
      backgroundColor: theme.palette.type === "dark" ? darkSecondary : "lightgrey",
    },
    "& > h4": {
      fontSize: 14,
      fontWeight: 400,
      marginLeft: 10,
      [theme.breakpoints.down("md")]: {
        display: "none",
      },
    },
  },
}));
