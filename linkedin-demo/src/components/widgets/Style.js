import { makeStyles } from "@material-ui/core/styles";
import { LinkedInLightBlue, darkSecondary } from "../../assets/Colors";

export default makeStyles((theme) => ({
  widgets: {
    height: "100%",
    display: "flex",
    flexDirection: "column",
  },
  widgets__top: {
    overflow: "hidden",
    borderRadius: 10,
  },
  heading: {
    width: "100%",
    height: 30,
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    padding: "20px 15px",
    "& > h4": {
      fontSize: 15,
      fontWeight: 600,
    },
    "& > .MuiSvgIcon-root": {
      fontSize: 16,
      color: "grey",
    },
  },
  expand: {
    width: "100%",
    height: 30,
    display: "flex",
    justifyContent: "center",
    alignItems: "center",
    cursor: "pointer",
    color: "grey",
    transition: "all 0.4s ease",
    "& > h4": {
      fontSize: 13,
      fontWeight: 600,
    },
    "&:hover": {
      backgroundColor: theme.palette.type === "dark" ? darkSecondary : "lightgrey",
    },
  },
  widgets__bottom: {
    position: "sticky",
    top: "8vh",
    marginTop: 10,
  },
  addBanner: {
    width: "100%",
    display: "flex",
    flexDirection: "column",
    padding: "12px 14px",
    borderRadius: 10,
    overflow: "hidden",
    border: `1px solid ${LinkedInLightBlue}`,
    background:
      theme.palette.type === "dark"
        ? `linear-gradient(120deg, ${theme.palette.primary.main} 0%, ${theme.palette.primary.dark} 100%)`
        : "linear-gradient(120deg, #e8f5e9 0%, #c8e6c9 100%)",
    "& > h4": {
      margin: 0,
      fontSize: 17,
      fontWeight: 700,
      color: theme.palette.type === "dark" ? "#e8f5e9" : theme.palette.primary.dark,
    },
    "& > p": {
      margin: "8px 0 0 0",
      fontSize: 13,
      lineHeight: 1.4,
      color: theme.palette.type === "dark" ? "#c8e6c9" : theme.palette.primary.main,
    },
  },
}));
