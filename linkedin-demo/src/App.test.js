import { render, screen, waitFor } from "@testing-library/react";
import { Provider } from "react-redux";
import { applyMiddleware, createStore } from "redux";
import thunk from "redux-thunk";
import App from "./App";
import reducers from "./store/reducers";
import { useConvexAuth, useMutation } from "convex/react";

jest.mock("lottie-web", () => ({
  loadAnimation: jest.fn(),
}));

jest.mock("convex/react", () => ({
  useConvexAuth: jest.fn(),
  useMutation: jest.fn(),
  useQuery: jest.fn(),
}));

jest.mock("@convex-dev/auth/react", () => ({
  useAuthActions: jest.fn(() => ({
    signIn: jest.fn(),
    signOut: jest.fn(),
  })),
}));

const renderApp = () => {
  const store = createStore(reducers, applyMiddleware(thunk));

  render(
    <Provider store={store}>
      <App />
    </Provider>
  );

  return store;
};

test("renders Convex Auth login screen when unauthenticated", async () => {
  const seedMutation = jest.fn().mockResolvedValue({ seeded: false });
  useConvexAuth.mockReturnValue({
    isAuthenticated: false,
    isLoading: false,
  });
  useMutation.mockReturnValue(seedMutation);

  renderApp();

  expect(screen.getByText("TurtleIn")).not.toBeNull();
  expect(screen.getByRole("button", { name: "🐢 Continue as Turtle" })).not.toBeNull();
  expect(screen.getByRole("button", { name: "Sign in with GitHub" })).not.toBeNull();
  expect(screen.getByRole("button", { name: /Sign in with Google/ })).not.toBeNull();
  expect(screen.queryByPlaceholderText("Start a post")).toBeNull();

  await waitFor(() => {
    expect(seedMutation).toHaveBeenCalled();
  });
});
