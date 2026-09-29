/* Выбор файлов вместо голого <input type="file">. Сам input остаётся: он в порядке Tab,
   открывает системный выбор (галерея, камера, файлы) и читается диктором с подписью —
   своё только лицо: рамка с иконкой, подписью и подсказкой, а на компьютере ещё и
   перетаскивание файлов. Выбранные файлы уходят в onFiles; поле сразу очищается, чтобы
   тот же файл можно было выбрать снова. */

import { type ChangeEvent, type DragEvent, type ReactNode, useId, useRef, useState } from "react";
import { UiIcon } from "./icons";

export interface FileDropProps {
  readonly onFiles: (files: File[]) => void;
  /** Главная подпись: «Добавить фото» */
  readonly title: ReactNode;
  /** Вторая строка: форматы, «или перетащите сюда» */
  readonly hint?: ReactNode;
  /** Как у input: "image/jpeg,image/png" */
  readonly accept?: string;
  readonly multiple?: boolean;
  readonly disabled?: boolean;
  readonly id?: string;
  readonly "aria-describedby"?: string;
  readonly className?: string;
}

/** Файл подходит под accept: MIME целиком, группа «image/*» или расширение «.png» */
export function accepts(file: File, accept: string | undefined): boolean {
  if (!accept) return true;
  const name = file.name.toLowerCase();
  const type = file.type.toLowerCase();
  return accept
    .split(",")
    .map((rule) => rule.trim().toLowerCase())
    .filter(Boolean)
    .some((rule) =>
      rule.startsWith(".")
        ? name.endsWith(rule)
        : rule.endsWith("/*")
          ? type.startsWith(rule.slice(0, -1))
          : type === rule,
    );
}

export function FileDrop({
  onFiles,
  title,
  hint,
  accept,
  multiple = false,
  disabled = false,
  id,
  className,
  "aria-describedby": describedBy,
}: FileDropProps) {
  const auto = useId();
  const inputId = id ?? auto;
  const [dragging, setDragging] = useState(false);
  const depth = useRef(0);

  const take = (list: FileList | null) => {
    const files = [...(list ?? [])].filter((file) => accepts(file, accept));
    if (files.length > 0) onFiles(multiple ? files : files.slice(0, 1));
  };

  const onChange = (event: ChangeEvent<HTMLInputElement>) => {
    const { files } = event.target;
    take(files);
    event.target.value = "";
  };

  // dragenter/dragleave приходят и от вложенных элементов — считаем глубину
  const onDragEnter = (event: DragEvent) => {
    if (disabled) return;
    event.preventDefault();
    depth.current += 1;
    setDragging(true);
  };
  const onDragLeave = () => {
    depth.current = Math.max(0, depth.current - 1);
    if (depth.current === 0) setDragging(false);
  };
  const onDragOver = (event: DragEvent) => {
    if (disabled) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
  };
  const onDrop = (event: DragEvent) => {
    event.preventDefault();
    depth.current = 0;
    setDragging(false);
    if (!disabled) take(event.dataTransfer.files);
  };

  const classes = ["ui-drop", dragging ? "is-dragging" : "", disabled ? "is-disabled" : "", className ?? ""]
    .filter(Boolean)
    .join(" ");

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: перетаскивание — добавка для мыши; основной путь — input
    <div
      className={classes}
      onDragEnter={onDragEnter}
      onDragLeave={onDragLeave}
      onDragOver={onDragOver}
      onDrop={onDrop}
    >
      <input
        id={inputId}
        className="ui-native"
        type="file"
        accept={accept}
        multiple={multiple}
        disabled={disabled}
        aria-describedby={describedBy}
        onChange={onChange}
      />
      <label className="ui-drop-face" htmlFor={inputId}>
        <span className="ui-drop-icon" aria-hidden="true">
          <UiIcon name="upload" size={20} />
        </span>
        <span className="ui-drop-text">
          <span className="ui-drop-title">{title}</span>
          {hint ? <span className="ui-drop-hint">{hint}</span> : null}
        </span>
      </label>
    </div>
  );
}
