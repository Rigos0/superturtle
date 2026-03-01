import { useEffect, useRef } from "react";
import { makeStyles } from "@material-ui/core/styles";
import lottie from "lottie-web";

const styles = makeStyles((theme) => ({
  root: {
    width: "100%",
    height: "100%",
    zIndex: 10000,
  },
}));

const Animation = ({ src }) => {
  const classes = styles();

  const container = useRef(null);

  useEffect(() => {
    lottie.loadAnimation({
      container: container.current,
      renderer: "svg",
      loop: true,
      autoplay: true,
      animationData: src,
    });
  }, [src]);

  return <div className={classes.root} ref={container}></div>;
};

export default Animation;
