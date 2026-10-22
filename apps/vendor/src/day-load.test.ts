import type { DayPart, VendorRequestDay } from "@bayramm/shared/api/vendor";
import { DEFAULT_DAY_PARTS } from "@bayramm/shared/categories";
import { describe, expect, it } from "vitest";
import { requestDayState } from "./day-load";
import { vendorDict } from "./i18n";

const { ru } = vendorDict;
const DAY = "2026-11-14";
const PARTS: DayPart[] = ["morning", "day", "evening"];

const day = (patch: Partial<VendorRequestDay> = {}, capacity = 2): VendorRequestDay => ({
  sessions: {
    mode: "parts",
    parts: [...PARTS],
    windows: DEFAULT_DAY_PARTS,
    custom: null,
    parallelCapacity: capacity,
  },
  busy: null,
  parts: [],
  bookings: [],
  ...patch,
});

describe("занятость даты заявки", () => {
  it("свободно, «вечер — занято 1 из 2 мест», «вечер — занято»", () => {
    expect(requestDayState(day(), DAY, ["evening"], ru)).toEqual({ tone: "free", text: "вечер — свободно" });
    const booked = day({ bookings: [{ day: DAY, part: "evening", count: 1 }] });
    expect(requestDayState(booked, DAY, ["evening"], ru)).toEqual({
      tone: "partial",
      text: "вечер — занято 1 из 2 мест",
    });
    const full = day({ parts: [{ day: DAY, part: "evening", source: "vendor", requestId: null }] });
    expect(requestDayState(full, DAY, ["evening"], ru)).toEqual({ tone: "busy", text: "вечер — занято" });
  });

  it("заявка на весь день: день целиком — свободен, частично, закрыт", () => {
    expect(requestDayState(day(), DAY, [], ru)).toEqual({ tone: "free", text: "свободно" });
    const part = day({ parts: [{ day: DAY, part: "morning", source: "vendor", requestId: null }] });
    expect(requestDayState(part, DAY, [], ru)).toEqual({ tone: "partial", text: "частично занят" });
    const closed = day({ busy: { day: DAY, source: "staff", requestId: null } });
    expect(requestDayState(closed, DAY, ["evening"], ru)).toEqual({ tone: "busy", text: "закрыл менеджер" });
  });

  it("одно мероприятие в день: договорённость и места", () => {
    const whole = (count: number, capacity: number) =>
      day(
        {
          sessions: { ...day().sessions, mode: "whole", parallelCapacity: capacity },
          bookings: PARTS.map((part) => ({ day: DAY, part, count })),
        },
        capacity,
      );
    expect(requestDayState(whole(1, 2), DAY, ["evening"], ru)).toEqual({
      tone: "partial",
      text: "занято 1 из 2 мест",
    });
    expect(requestDayState(whole(1, 1), DAY, [], ru).tone).toBe("busy");
  });
});
