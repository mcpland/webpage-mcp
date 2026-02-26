import "./ProgressIndicator.css";

export type ProgressIndicatorProps = {
  visible?: boolean;
  text: string;
  showSpinner?: boolean;
};

export function ProgressIndicator({
  visible = true,
  text,
  showSpinner = true,
}: ProgressIndicatorProps) {
  if (!visible) {
    return null;
  }

  return (
    <div className="progress-section">
      <div className="progress-indicator">
        {showSpinner ? <div className="spinner" /> : null}
        <span className="progress-text">{text}</span>
      </div>
    </div>
  );
}
