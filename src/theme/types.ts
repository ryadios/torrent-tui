// Color scheme type definition

export interface ColorScheme {
	// Backgrounds
	bgPrimary: string;
	bgSecondary: string;
	bgTertiary: string;

	// Foregrounds
	fgPrimary: string;
	fgSecondary: string;
	fgMuted: string;

	// Accents
	accent: string;
	accentHover: string;

	// Status
	success: string;
	warning: string;
	error: string;

	// Borders
	border: string;
	borderFocused: string;
}
