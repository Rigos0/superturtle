import { makeStyles } from "@material-ui/core/styles";
import { darkSecondary, darkPrimary } from "../../assets/Colors";

export default makeStyles((theme) => ({
  header: {
    width: "100%",
    height: "100%",
    display: "flex",
    justifyContent: "center",
    alignItems: "center",
    borderRadius: 0,
  },
  header__container: {
    minWidth: 1150,
    maxWidth: 1150,
    [theme.breakpoints.down("md")]: {
      minWidth: 940,
      maxWidth: 940,
    },
    [theme.breakpoints.down("sm")]: {
      minWidth: "100%",
    },
    height: "100%",
    display: "flex",
    justifyContent: "center",
    alignItems: "center",
  },
  header__logo: {
    flex: 4,
    height: "100%",
    display: "flex",
    alignItems: "center",
    padding: "0 10px",
    "& > img": {
      height: 32,
      [theme.breakpoints.down("xs")]: {
        height: 28,
      },
    },
    "& > .MuiAvatar-root": {
      display: "none",
      [theme.breakpoints.down("xs")]: {
        display: "block",
        width: 28,
        height: 28,
        marginLeft: 10,
      },
    },
  },
  search: {
    width: "60%",
    [theme.breakpoints.down("xs")]: {
      width: "100%",
    },
    height: "65%",
    display: "flex",
    alignItems: "center",
    marginLeft: 10,
    padding: "0 10px",
    borderRadius: 3,
    backgroundColor: theme.palette.type === "dark" ? darkSecondary : "#eef3f8",
    overflow: "hidden",
    "& > input": {
      width: "100%",
      height: "100%",
      marginLeft: 5,
      border: 0,
      outlineWidth: 0,
      color: theme.palette.type === "dark" && "lightgrey",
      backgroundColor: "transparent",
      "&::placeholder": {
        color: theme.palette.type === "dark" && "grey",
      },
    },
  },
  header__nav: {
    flex: 6,
    height: "100%",
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    "& > div": {
      flex: 1,
      height: "85%",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      "&:hover": {
        backgroundColor: theme.palette.type === "dark" ? darkSecondary : "lightgrey",
        borderRadius: 2,
      },
    },
    "& > div:nth-child(6)": {
      borderLeft: `1px solid ${theme.palette.type === "dark" ? darkPrimary : "lightgrey"}`,
      borderRight: `1px solid ${theme.palette.type === "dark" ? darkPrimary : "lightgrey"}`,
    },
    [theme.breakpoints.down("xs")]: {
      display: "none",
    },
  },
  header__bottom__nav: {
    display: "none",
    borderRadius: 0,
    boxShadow: "0px -3px 5px -5px rgba(0,0,0,0.75)",
    [theme.breakpoints.down("xs")]: {
      position: "fixed",
      bottom: 0,
      width: "100%",
      height: 50,
      display: "flex",
      justifyContent: "space-between",
      alignItems: "center",
      padding: "0 10px",
      "& > .MuiSvgIcon-root": {
        fontSize: 24,
        color: "grey",
        cursor: "pointer",
      },
    },
  },
}));
