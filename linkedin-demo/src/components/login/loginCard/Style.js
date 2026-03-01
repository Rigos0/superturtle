import { makeStyles } from "@material-ui/core/styles";

export default makeStyles((theme) => ({
  card: {
    width: 360,
    [theme.breakpoints.down("xs")]: {
      width: "100%",
      border: 0,
      borderRadius: 0,
      boxShadow: "none",
    },
    height: 500,
    display: "flex",
    flexDirection: "column",
    justifyContent: "space-between",
    alignItems: "center",
  },

  header: {
    width: "100%",
    display: "flex",
    justifyContent: "center",
    alignItems: "center",
    marginTop: 20,
    "& > img": {
      width: "auto",
      height: 35,
    },
  },

  form: {
    width: 250,
    height: 200,
    display: "flex",
    flexDirection: "column",
    justifyContent: "space-evenly",
    "& > input": {
      outlineWidth: 0,
      height: 35,
      border: "1px solid lightgrey",
      borderRadius: 2,
      padding: "0 10px",
    },
    "& > button": {
      height: 30,
      border: "1px solid lightgrey",
      borderRadius: 4,
      color: "white",
      fontSize: 14,
      fontWeight: 600,
      backgroundColor: "#5d98d4",
    },
  },

  google: {
    width: "100%",
    display: "flex",
    flexDirection: "column",
    justifyContent: "center",
    alignItems: "center",
    "& > section": {
      width: "100%",
      display: "flex",
      justifyContent: "center",
      alignItems: "center",
      padding: "0 10px",
      "& > div": {
        flex: 1,
        height: 1,
        display: "flex",
        justifyContent: "center",
        alignItems: "center",
        backgroundColor: "lightgrey",
        opacity: 0.5,
      },
      "& > p": {
        display: "flex",
        justifyContent: "center",
        alignItems: "center",
        padding: "0 10px",
        fontSize: 12,
        color: "grey",
      },
    },
  },

  about: {
    width: "100%",
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    "& > section": {
      width: "100%",
      display: "flex",
      justifyContent: "center",
      alignItems: "center",
      padding: "0 10px",
      marginBottom: 5,
      "& > div": {
        flex: 1,
        height: 1,
        display: "flex",
        justifyContent: "center",
        alignItems: "center",
        backgroundColor: "lightgrey",
        opacity: 0.5,
      },
      "& > p": {
        display: "flex",
        justifyContent: "center",
        alignItems: "center",
        padding: "0 10px",
        fontSize: 10,
        color: "grey",
      },
    },
  },

  social__links: {
    width: "100%",
    display: "flex",
    justifyContent: "space-evenly",
    alignItems: "center",
    margin: "4px 0",
    "& > a": {
      color: "grey",
      "& > .MuiSvgIcon-root": {
        fontSize: 18,
      },
    },
  },
}));
