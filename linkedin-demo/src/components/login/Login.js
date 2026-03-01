import { makeStyles } from "@material-ui/core/styles";
import LoginCard from "./loginCard/LoginCard";
import Animation from "../../components/animations/Animation";
import LottieRelaxing from "../../assets/images/relaxing.json";

const Style = makeStyles((theme) => ({
  login: {
    width: "100vw",
    height: "100vh",
    display: "flex",
    justifyContent: "center",
    alignItems: "center",
  },
  banner: {
    flex: 1,
    height: "100%",
    display: "flex",
    justifyContent: "center",
    alignItems: "center",
    [theme.breakpoints.down("sm")]: {
      display: "none",
    },
    "& > *": {
      height: 550,
    },
  },
  loginCard: {
    height: "100%",
    display: "flex",
    justifyContent: "center",
    alignItems: "center",
    padding: "0 50px",
    [theme.breakpoints.down("sm")]: {
      padding: 0,
    },
    [theme.breakpoints.down("xs")]: {
      width: "90%",
    },
  },
}));

const Login = () => {
  const classes = Style();
  return (
    <div className={classes.login}>
      <div className={classes.banner}>
        <Animation src={LottieRelaxing} />
      </div>
      <div className={classes.loginCard}>
        <LoginCard />
      </div>
    </div>
  );
};

export default Login;
