/**
 * Slider Input Component
 *
 * A reusable "slider + input" control for numeric values:
 * - Left: native range slider for visual manipulation
 * - Right: InputContainer-backed numeric input for precise values
 *
 * Features:
 * - Bidirectional synchronization between slider and input
 * - Supports disabled state
 * - Accessible with ARIA labels
 *
 * Styling is defined in shadow-host.ts:
 * - `.we-slider-input`
 * - `.we-slider-input__slider`
 * - `.we-slider-input__number`
 */

import { createInputContainer, type InputContainer } from './input-container';

// =============================================================================
// Types
// =============================================================================

export interface SliderInputOptions {
  /** Accessible label for the range slider */
  sliderAriaLabel: string;
  /** Accessible label for the numeric input */
  inputAriaLabel: string;
  /** Minimum value for the slider */
  min: number;
  /** Maximum value for the slider */
  max: number;
  /** Step increment for the slider */
  step: number;
  /** Input mode for the numeric input (default: "decimal") */
  inputMode?: string;
  /** Fixed width for the numeric input in pixels (default: 72) */
  inputWidthPx?: number;
}

export interface SliderInput {
  /** Root container element */
  root: HTMLDivElement;
  /** Range slider element */
  slider: HTMLInputElement;
  /** Numeric input element */
  input: HTMLInputElement;
  /** Input container instance for advanced customization */
  inputContainer: InputContainer;
  /** Set disabled state for both controls */
  setDisabled(disabled: boolean): void;
  /** Set disabled state for slider only */
  setSliderDisabled(disabled: boolean): void;
  /** Set value for both controls */
  setValue(value: number): void;
  /** Set slider value only (without affecting input) */
  setSliderValue(value: number): void;
}

// =============================================================================
// Factory
// =============================================================================

/**
 * Create a slider input component with synchronized slider and input
 */
export function createSliderInput(options: SliderInputOptions): SliderInput {
  const {
    sliderAriaLabel,
    inputAriaLabel,
    min,
    max,
    step,
    inputMode = 'decimal',
    inputWidthPx = 72,
  } = options;

  // Root container
  const root = document.createElement('div');
  root.className = 'we-slider-input';

  // Range slider
  const slider = document.createElement('input');
  slider.type = 'range';
  slider.className = 'we-slider-input__slider';
  slider.min = String(min);
  slider.max = String(max);
  slider.step = String(step);
  slider.value = String(min);
  slider.setAttribute('aria-label', sliderAriaLabel);

  /**
   * Update the slider's progress color based on current value.
   * Uses CSS custom property --progress for the gradient.
   */
  function updateSliderProgress(): void {
    const value = parseFloat(slider.value);
    const minVal = parseFloat(slider.min);
    const maxVal = parseFloat(slider.max);
    const percent = ((value - minVal) / (maxVal - minVal)) * 100;
    slider.style.setProperty('--progress', `${percent}%`);
  }

  // Initialize progress
  updateSliderProgress();

  // Update progress on input
  slider.addEventListener('input', updateSliderProgress);

  // Numeric input using InputContainer
  const inputContainer = createInputContainer({
    ariaLabel: inputAriaLabel,
    inputMode,
    prefix: null,
    suffix: null,
    rootClassName: 'we-slider-input__number',
  });
  inputContainer.root.style.width = `${inputWidthPx}px`;
  inputContainer.root.style.flex = '0 0 auto';

  root.append(slider, inputContainer.root);

  // Public methods
  function setDisabled(disabled: boolean): void {
    slider.disabled = disabled;
    inputContainer.input.disabled = disabled;
  }

  function setSliderDisabled(disabled: boolean): void {
    slider.disabled = disabled;
  }

  function setValue(value: number): void {
    const stringValue = String(value);
    slider.value = stringValue;
    inputContainer.input.value = stringValue;
    updateSliderProgress();
  }

  function setSliderValue(value: number): void {
    slider.value = String(value);
    updateSliderProgress();
  }

  return {
    root,
    slider,
    input: inputContainer.input,
    inputContainer,
    setDisabled,
    setSliderDisabled,
    setValue,
    setSliderValue,
  };
}
