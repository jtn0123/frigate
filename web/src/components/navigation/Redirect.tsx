import { useEffect } from "react";
import { useNavigate } from "react-router-dom";

type RedirectProps = {
  to: string;
};
export function Redirect({ to }: Readonly<RedirectProps>) {
  const navigate = useNavigate();

  useEffect(() => {
    navigate(to);
  }, [to, navigate]);
  return <div />;
}
