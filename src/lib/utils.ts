import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * Résout une URL d'asset public (root-relative, ex. "/world.json") sous
 * `import.meta.env.BASE_URL` — nécessaire dès que l'app n'est pas servie à
 * la racine du domaine (ex. GitHub Pages : `/Rise-and-Rule/`). `BASE_URL`
 * se termine toujours par `/` ; on retire le `/` initial de `path` pour ne
 * pas le dupliquer.
 */
export function withBase(path: string): string {
  return `${import.meta.env.BASE_URL}${path.replace(/^\//, "")}`;
}
