import React from "react";
import {
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  TextField,
  Typography,
} from "@material-ui/core";
import { fade, useTheme } from "@material-ui/core/styles";

const formatExperienceDateRange = (startDate, endDate) => {
  const hasStartDate = typeof startDate === "string" && startDate.trim().length > 0;
  const hasEndDate = typeof endDate === "string" && endDate.trim().length > 0;

  if (hasStartDate && hasEndDate) {
    return `${startDate} - ${endDate}`;
  }

  if (hasStartDate) {
    return `${startDate} - Present`;
  }

  return "";
};

const ExperienceSection = ({
  isOwnProfile,
  experienceEntries,
  legacyExperience,
  isExperienceSavePending,
  isExperienceDialogOpen,
  editingExperienceId,
  experienceFormData,
  onOpenCreateDialog,
  onOpenEditDialog,
  onRemoveExperience,
  onCloseDialog,
  onSaveExperience,
  onExperienceFieldChange,
}) => {
  const theme = useTheme();

  return (
    <>
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 8,
        marginBottom: 6,
      }}
    >
      <Typography variant="subtitle2" style={{ fontWeight: 700 }}>
        Experience
      </Typography>
      {isOwnProfile && (
        <Button
          size="small"
          variant="text"
          onClick={onOpenCreateDialog}
          style={{
            textTransform: "none",
            color: theme.palette.primary.main,
            fontWeight: 600,
            minHeight: 32,
          }}
        >
          Add experience
        </Button>
      )}
    </div>

    {experienceEntries.length === 0 && legacyExperience.length === 0 && (
      <Typography variant="body2" color="textSecondary">
        No experience added yet.
      </Typography>
    )}

    {experienceEntries.map((entry) => {
      const dateRange = formatExperienceDateRange(entry.startDate, entry.endDate);
      return (
        <div
          key={entry.id}
          style={{
            border: `1px solid ${fade(theme.palette.primary.main, 0.2)}`,
            borderRadius: 10,
            padding: "10px 12px",
            marginBottom: 10,
          }}
        >
          <Typography variant="subtitle2" style={{ fontWeight: 700, marginBottom: 2 }}>
            {entry.title}
          </Typography>
          <Typography
            variant="body2"
            color="textSecondary"
            style={{ fontWeight: 600, marginBottom: dateRange ? 2 : 6 }}
          >
            {entry.company}
          </Typography>
          {dateRange && (
            <Typography
              variant="body2"
              color="textSecondary"
              style={{ fontSize: "0.8rem", marginBottom: entry.description ? 6 : 2 }}
            >
              {dateRange}
            </Typography>
          )}
          {entry.description && (
            <Typography
              variant="body2"
              color="textSecondary"
              style={{ whiteSpace: "pre-line", lineHeight: 1.55, marginBottom: 6 }}
            >
              {entry.description}
            </Typography>
          )}
          {isOwnProfile && (
            <div style={{ display: "flex", gap: 6 }}>
              <Button
                size="small"
                variant="outlined"
                onClick={() => onOpenEditDialog(entry)}
                disabled={isExperienceSavePending}
                style={{
                  textTransform: "none",
                  borderRadius: 16,
                  borderColor: theme.palette.primary.main,
                  color: theme.palette.primary.main,
                  fontWeight: 600,
                  padding: "2px 10px",
                }}
              >
                Edit
              </Button>
              <Button
                size="small"
                variant="outlined"
                onClick={() => onRemoveExperience(entry.id)}
                disabled={isExperienceSavePending}
                style={{
                  textTransform: "none",
                  borderRadius: 16,
                  borderColor: "#c62828",
                  color: "#c62828",
                  fontWeight: 600,
                  padding: "2px 10px",
                }}
              >
                Delete
              </Button>
            </div>
          )}
        </div>
      );
    })}

    {legacyExperience.map((exp, index) => (
      <Typography
        key={`${exp}-${index}`}
        variant="body2"
        color="textSecondary"
        style={{ marginBottom: 4, lineHeight: 1.55 }}
      >
        {exp}
      </Typography>
    ))}

    <Divider style={{ margin: "16px 0 12px" }} />

    <Dialog
      open={isExperienceDialogOpen}
      onClose={() => onCloseDialog()}
      fullWidth
      maxWidth="sm"
      aria-labelledby="experience-dialog-title"
    >
      <DialogTitle id="experience-dialog-title">
        {editingExperienceId ? "Edit experience" : "Add experience"}
      </DialogTitle>
      <DialogContent dividers>
        <TextField
          label="Title"
          value={experienceFormData.title}
          onChange={onExperienceFieldChange("title")}
          variant="outlined"
          margin="dense"
          fullWidth
          required
        />
        <TextField
          label="Company"
          value={experienceFormData.company}
          onChange={onExperienceFieldChange("company")}
          variant="outlined"
          margin="dense"
          fullWidth
          required
        />
        <TextField
          label="Start date"
          placeholder="e.g. Jan 2022"
          value={experienceFormData.startDate}
          onChange={onExperienceFieldChange("startDate")}
          variant="outlined"
          margin="dense"
          fullWidth
          required
        />
        <TextField
          label="End date"
          placeholder="e.g. Present"
          value={experienceFormData.endDate}
          onChange={onExperienceFieldChange("endDate")}
          variant="outlined"
          margin="dense"
          fullWidth
        />
        <TextField
          label="Description"
          value={experienceFormData.description}
          onChange={onExperienceFieldChange("description")}
          variant="outlined"
          margin="dense"
          fullWidth
          multiline
          rows={3}
        />
      </DialogContent>
      <DialogActions>
        <Button onClick={() => onCloseDialog()} disabled={isExperienceSavePending}>
          Cancel
        </Button>
        <Button
          onClick={onSaveExperience}
          variant="contained"
          color="primary"
          disabled={isExperienceSavePending}
        >
          {editingExperienceId ? "Update" : "Save"}
        </Button>
      </DialogActions>
    </Dialog>
    </>
  );
};

export default ExperienceSection;
