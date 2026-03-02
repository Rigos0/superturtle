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
    gap: 8,
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
    "& > select": {
      height: "100%",
      border: 0,
      outlineWidth: 0,
      padding: "0 10px",
      backgroundColor: "transparent",
      color: theme.palette.type === "dark" ? "lightgrey" : "#333",
      fontSize: 13,
      fontWeight: 600,
      borderLeft:
        theme.palette.type === "dark"
          ? "1px solid rgba(225,225,225,0.1)"
          : "1px solid rgba(0,0,0,0.12)",
      cursor: "pointer",
      "&:disabled": {
        cursor: "not-allowed",
        opacity: 0.7,
      },
    },
    "& > button": {
      height: "100%",
      display: "flex",
      alignItems: "center",
      padding: "0 15px",
      border: 0,
      outlineWidth: 0,
      backgroundColor: "#2e7d32",
      color: "white",
      cursor: "pointer",
      fontWeight: 600,
      transition: "all 0.4s ease",
      "&:hover": {
        backgroundColor: "#1b5e20",
      },
    },
  },

  headerTextField: {
    flex: 1,
    "& .MuiInputBase-root": {
      height: "100%",
      color: theme.palette.type === "dark" ? "lightgrey" : "inherit",
    },
    "& .MuiInputBase-input": {
      height: "100%",
      boxSizing: "border-box",
      padding: "0 10px",
      color: theme.palette.type === "dark" ? "lightgrey" : "inherit",
      fontSize: 14,
      fontWeight: 600,
      backgroundColor: "transparent",
      "&::placeholder": {
        color: theme.palette.type === "dark" ? "grey" : "inherit",
        opacity: 1,
      },
    },
  },

  writeArticleButton: {
    height: 40,
    border: 0,
    outlineWidth: 0,
    borderRadius: 999,
    padding: "0 14px",
    backgroundColor: "rgba(46,125,50,0.1)",
    color: "#2e7d32",
    fontWeight: 700,
    fontSize: 13,
    cursor: "pointer",
    whiteSpace: "nowrap",
    transition: "background-color 0.2s ease, color 0.2s ease",
    "&:hover": {
      backgroundColor: "rgba(46,125,50,0.18)",
      color: "#1b5e20",
    },
    [theme.breakpoints.down("xs")]: {
      height: 36,
      padding: "0 10px",
      fontSize: 12,
    },
  },

  selectedFile: {
    display: "flex",
    alignItems: "center",
    flexWrap: "wrap",
    gap: 6,
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

  pollComposer: {
    display: "flex",
    flexDirection: "column",
    gap: 8,
    margin: "8px 0 6px",
    padding: "10px 12px",
    borderRadius: 10,
    border:
      theme.palette.type === "dark"
        ? "1px solid rgba(225,225,225,0.1)"
        : "1px solid rgba(0,0,0,0.1)",
    backgroundColor: theme.palette.type === "dark" ? darkSecondary : "rgba(46,125,50,0.04)",
  },

  pollLabel: {
    fontSize: 12,
    fontWeight: 700,
    color: theme.palette.type === "dark" ? "rgba(255,255,255,0.9)" : "#1b5e20",
    textTransform: "uppercase",
    letterSpacing: 0.3,
  },

  pollInput: {
    width: "100%",
    border: 0,
    outlineWidth: 0,
    borderRadius: 8,
    padding: "10px 12px",
    fontSize: 14,
    color: theme.palette.type === "dark" ? "lightgrey" : "#222",
    backgroundColor: theme.palette.type === "dark" ? "rgba(0,0,0,0.25)" : "#fff",
  },

  pollOptions: {
    display: "flex",
    flexDirection: "column",
    gap: 6,
  },

  pollOptionRow: {
    display: "flex",
    alignItems: "center",
    gap: 6,
  },

  pollOptionInput: {
    flex: 1,
    border: 0,
    outlineWidth: 0,
    borderRadius: 8,
    padding: "9px 12px",
    fontSize: 13,
    color: theme.palette.type === "dark" ? "lightgrey" : "#222",
    backgroundColor: theme.palette.type === "dark" ? "rgba(0,0,0,0.25)" : "#fff",
  },

  pollRemoveOption: {
    width: 32,
    height: 32,
    border: 0,
    borderRadius: 999,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    cursor: "pointer",
    color: theme.palette.type === "dark" ? "#f5b5b5" : "#c62828",
    backgroundColor: theme.palette.type === "dark" ? "rgba(255,255,255,0.08)" : "rgba(198,40,40,0.08)",
  },

  pollAddOption: {
    width: "fit-content",
    border: 0,
    outlineWidth: 0,
    borderRadius: 999,
    display: "flex",
    alignItems: "center",
    gap: 6,
    padding: "6px 10px",
    cursor: "pointer",
    fontWeight: 700,
    fontSize: 12,
    color: theme.palette.type === "dark" ? "#a5d6a7" : "#1b5e20",
    backgroundColor: theme.palette.type === "dark" ? "rgba(46,125,50,0.2)" : "rgba(46,125,50,0.15)",
    "&:disabled": {
      cursor: "not-allowed",
      opacity: 0.6,
    },
  },

  pollHint: {
    margin: 0,
    fontSize: 12,
    color: theme.palette.type === "dark" ? "rgba(255,255,255,0.65)" : "rgba(0,0,0,0.6)",
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
