import React from "react";
import { Button, Chip, TextField, Typography } from "@material-ui/core";
import { fade, useTheme } from "@material-ui/core/styles";

const SkillsSection = ({
  isOwnProfile,
  skills,
  skillInputValue,
  skillError,
  isSkillMutationPending,
  primaryColor,
  onSkillInputChange,
  onAddSkill,
  onRemoveSkill,
}) => {
  const theme = useTheme();

  return (
    <>
    <Typography variant="subtitle2" style={{ fontWeight: 700, marginBottom: 8 }}>
      Skills
    </Typography>

    {isOwnProfile && (
      <div
        style={{
          display: "flex",
          gap: 8,
          alignItems: "flex-start",
          marginBottom: 8,
          flexWrap: "wrap",
        }}
      >
        <TextField
          value={skillInputValue}
          onChange={onSkillInputChange}
          variant="outlined"
          margin="dense"
          placeholder="Add a skill"
          size="small"
          disabled={isSkillMutationPending}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              onAddSkill();
            }
          }}
          style={{ minWidth: 200, flexGrow: 1 }}
        />
        <Button
          size="small"
          variant="contained"
          onClick={onAddSkill}
          disabled={isSkillMutationPending}
          style={{
            textTransform: "none",
            backgroundColor: primaryColor,
            color: "#fff",
            fontWeight: 600,
            minHeight: 40,
            borderRadius: 18,
            padding: "0 16px",
          }}
        >
          Add
        </Button>
      </div>
    )}

    {skillError && (
      <Typography
        variant="body2"
        style={{ color: "#c62828", fontSize: "0.8rem", marginBottom: 8 }}
      >
        {skillError}
      </Typography>
    )}

    {skills.length === 0 ? (
      <Typography variant="body2" color="textSecondary">
        No skills added yet.
      </Typography>
    ) : (
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
        {skills.map((skill, index) => (
          <Chip
            key={`${skill}-${index}`}
            label={skill}
            size="small"
            onDelete={isOwnProfile ? () => onRemoveSkill(skill) : undefined}
            disabled={isSkillMutationPending}
            style={{
              backgroundColor: fade(theme.palette.primary.main, 0.12),
              color: theme.palette.primary.dark,
              fontWeight: 600,
            }}
          />
        ))}
      </div>
    )}
    </>
  );
};

export default SkillsSection;
