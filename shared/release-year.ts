// Keep legacy records/clients readable while new records only contain release_year.
export function yearOnly(data: Record<string, unknown>) {
  const { release_date, ...rest } = data;
  if (
    rest.release_year == null &&
    typeof release_date === 'string' &&
    /^\d{4}-\d{2}-\d{2}$/.test(release_date)
  ) {
    const year = Number(release_date.slice(0, 4));
    if (year >= 1950 && year <= 2200) rest.release_year = year;
  }
  return rest;
}
