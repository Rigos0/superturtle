import { makeStyles } from "@material-ui/core/styles";
import { LinkedInBlue, LinkedInLightBlue, darkSecondary } from "../../../assets/Colors";

export default makeStyles((theme) => ({
  sidebarBottom: {
    position: "sticky",
    top: "8vh",
    display: "flex",
    flexDirection: "column",
    marginTop: 10,
    borderRadius: 10,
    overflow: "hidden",
  },

  heading: {
    height: 40,
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    padding: "0 10px",
    cursor: "pointer",
    "&:hover .MuiSvgIcon-root": {
      // display: "block",
      // transition: "all 0.4s ease",
      // color: "grey",
      // "&:hover": {
      //   borderRadius: 999,
      //   backgroundColor: theme.palette.type === "dark" ? darkSecondary : "lightgrey",
      // },
    },
    "& > .MuiSvgIcon-root": {
      transition: "all 0.4s ease",
      color: "grey",
      "&:hover": {
        borderRadius: 999,
        backgroundColor: theme.palette.type === "dark" ? darkSecondary : "lightgrey",
      },
    },
    "& > h4": {
      fontSize: 13,
      fontWeight: 500,
      color: theme.palette.type === "dark" ? LinkedInLightBlue : LinkedInBlue,
      transition: "all 0.4s ease",
      "&:hover": {
        textDecoration: "underline",
      },
    },
  },

  discover__more: {
    height: 45,
    display: "flex",
    justifyContent: "center",
    alignItems: "center",
    cursor: "pointer",
    transition: "all 0.4s ease",
    "& > h4": {
      fontSize: 14,
      fontWeight: 500,
    },
    "&:hover": {
      backgroundColor: theme.palette.type === "dark" ? darkSecondary : "lightgrey",
    },
  },
}));
