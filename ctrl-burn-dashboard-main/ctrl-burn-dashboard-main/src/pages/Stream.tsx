import { Dashboard } from "@/components/ctrl/Dashboard";
import { useCtrlData } from "@/hooks/useCtrlData";

const Stream = () => {
  const { data, isGlitching, isCtrlPressed } = useCtrlData();

  return (
    <div className="flex h-screen items-start justify-center overflow-hidden bg-background p-2">
      <Dashboard streamMode data={data} isGlitching={isGlitching} isCtrlPressed={isCtrlPressed} />
    </div>
  );
};

export default Stream;
